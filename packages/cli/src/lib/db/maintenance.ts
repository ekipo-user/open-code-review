/**
 * Database maintenance — the operator-facing hygiene primitives behind
 * `ocr db doctor / prune / vacuum`.
 *
 * These are the PRODUCTIZED form of the one-time live-incident remediation that
 * shrank a corrupted 298 MB database to 8.5 MB: an FK-orphan sweep (84,611
 * violations → 0), markdown-artifact dedup (17,484 rows → 406), orphan-temp
 * reaping (~1 GB), and VACUUM. The migration runner heals a database silently
 * on upgrade (migration v14); this module makes the same hygiene a first-class,
 * on-demand, snapshot-guarded operator tool that also reports health.
 *
 * Invariants honored EVERYWHERE here:
 *  - `orchestration_events` and `sessions` are the immutable system of record.
 *    No operation deletes a row from them — the FK-orphan sweep PROTECTS them
 *    (a violation against a protected table is reported, never auto-deleted),
 *    and prune removes only the cascade *artifact* subtree, never events or the
 *    session row.
 *  - Every mutating entry point snapshots the DB file first (best-effort) so a
 *    bad sweep is always reversible.
 *  - `PRAGMA foreign_keys` is toggled only in autocommit (never inside a
 *    transaction, where SQLite silently ignores it).
 */

import {
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
  copyFileSync,
} from "node:fs";
import { dirname, join, basename } from "node:path";
import { isProcessAlive } from "@open-code-review/platform";
import type { Database } from "./engine.js";

/**
 * Tables the FK-orphan sweep must NEVER delete from, even when
 * `foreign_key_check` flags a violation against them. They are immutable
 * (`orchestration_events`) or the journal/projection roots (`sessions`,
 * `agent_sessions`, `command_executions`). A violation here signals deeper
 * corruption that warrants manual attention — not a silent auto-delete.
 */
const PROTECTED_TABLES = new Set<string>([
  "sessions",
  "orchestration_events",
  "agent_sessions",
  "command_executions",
  "schema_version",
]);

/**
 * The deletable cascade-artifact subtree, as anti-join deletes ordered
 * ROOT-FIRST so a single pass also reaps transitive orphans (a finding whose
 * reviewer_output is itself orphaned because its round's session is gone). Each
 * delete removes rows whose FK target no longer exists — including targets
 * removed earlier in this same ordered pass. This is the precise, index-friendly
 * form of the live remediation (no 170k-row rowid IN-lists).
 */
const ORPHAN_SWEEPS: ReadonlyArray<{ table: string; sql: string }> = [
  // session-rooted parents first
  {
    table: "review_rounds",
    sql: "DELETE FROM review_rounds WHERE session_id NOT IN (SELECT id FROM sessions)",
  },
  {
    table: "map_runs",
    sql: "DELETE FROM map_runs WHERE session_id NOT IN (SELECT id FROM sessions)",
  },
  {
    table: "markdown_artifacts",
    sql: "DELETE FROM markdown_artifacts WHERE session_id NOT IN (SELECT id FROM sessions)",
  },
  {
    table: "chat_conversations",
    sql: "DELETE FROM chat_conversations WHERE session_id NOT IN (SELECT id FROM sessions)",
  },
  // second level (pick up parents deleted above)
  {
    table: "reviewer_outputs",
    sql: "DELETE FROM reviewer_outputs WHERE round_id NOT IN (SELECT id FROM review_rounds)",
  },
  {
    table: "map_sections",
    sql: "DELETE FROM map_sections WHERE map_run_id NOT IN (SELECT id FROM map_runs)",
  },
  {
    table: "chat_messages",
    sql: "DELETE FROM chat_messages WHERE conversation_id NOT IN (SELECT id FROM chat_conversations)",
  },
  {
    table: "user_round_progress",
    sql: "DELETE FROM user_round_progress WHERE round_id NOT IN (SELECT id FROM review_rounds)",
  },
  // third level
  {
    table: "review_findings",
    sql: "DELETE FROM review_findings WHERE reviewer_output_id NOT IN (SELECT id FROM reviewer_outputs)",
  },
  {
    table: "map_files",
    sql: "DELETE FROM map_files WHERE section_id NOT IN (SELECT id FROM map_sections)",
  },
  // leaves
  {
    table: "user_finding_progress",
    sql: "DELETE FROM user_finding_progress WHERE finding_id NOT IN (SELECT id FROM review_findings)",
  },
  {
    table: "user_file_progress",
    sql: "DELETE FROM user_file_progress WHERE map_file_id NOT IN (SELECT id FROM map_files)",
  },
];

/**
 * Collapse markdown rows to the newest per logical key. NULL-safe via
 * IFNULL(round_number,-1), matching the unique index. Idempotent: a no-op once
 * the index is enforcing uniqueness.
 *
 * NOTE: migration v14 performs a byte-identical DELETE. The two are
 * DELIBERATELY independent copies — a migration is frozen history (its effect
 * on a not-yet-upgraded database must never change), whereas this is the live
 * operational tool. Coupling them to one constant would let an edit here
 * retroactively alter what v14 does on un-migrated machines (round-1 SF16 was
 * declined for exactly this immutability reason).
 */
const MARKDOWN_DEDUP_SQL = `
  DELETE FROM markdown_artifacts
   WHERE rowid NOT IN (
     SELECT MAX(rowid) FROM markdown_artifacts
      GROUP BY session_id, artifact_type, IFNULL(round_number, -1), file_path
   )`;

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Run `fn` with FK enforcement disabled, restoring it afterward. `PRAGMA
 * foreign_keys` is honored only in autocommit, so this must NOT be called from
 * inside an open transaction. The single home for the toggle pattern — shared
 * by {@link fixDb}'s orphan sweep and the maintenance test fixture (round-1 SF17).
 */
export function withForeignKeysDisabled<T>(db: Database, fn: () => T): T {
  db.pragma("foreign_keys = OFF");
  try {
    return fn();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

// ── Health report ──

export type FkViolationGroup = { table: string; count: number };
export type OrphanTempFile = {
  name: string;
  pid: number | null;
  ageMs: number;
  reapable: boolean;
};
export type BackupFile = { name: string; sizeBytes: number };

export type DbHealthReport = {
  dbPath: string;
  fileSizeBytes: number;
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  /** Bytes the freelist is holding that a VACUUM would return to the OS. */
  reclaimableBytes: number;
  integrityOk: boolean;
  integrityErrors: string[];
  /** Violations in deletable (cascade-artifact) tables — `doctor --fix` clears these. */
  fkViolations: FkViolationGroup[];
  /** Violations in protected (system-of-record) tables — manual attention. */
  protectedFkViolations: FkViolationGroup[];
  totalFkViolations: number;
  /** Markdown rows that exceed one-per-logical-key (would be removed by dedup). */
  markdownDuplicateRows: number;
  orphanTempFiles: OrphanTempFile[];
  backupFiles: BackupFile[];
  /** System-of-record counts — reported for confidence; never mutated. */
  eventCount: number;
  sessionCount: number;
};

/** Read a single scalar integer from a one-cell result (PRAGMA / COUNT). */
function scalarInt(db: Database, sql: string): number {
  const r = db.exec(sql);
  const v = r[0]?.values[0]?.[0];
  return typeof v === "number" ? v : Number(v ?? 0);
}

/** Group `PRAGMA foreign_key_check` rows by child table into counts. */
function foreignKeyViolationGroups(db: Database): FkViolationGroup[] {
  // Columns: table | rowid | parent | fkid — one row per violating child row.
  const r = db.exec("PRAGMA foreign_key_check");
  const rows = r[0]?.values ?? [];
  const counts = new Map<string, number>();
  for (const row of rows) {
    const table = String(row[0]);
    counts.set(table, (counts.get(table) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([table, count]) => ({ table, count }))
    .sort((a, b) => b.count - a.count);
}

/** Classify `ocr.db.<pid>.tmp` atomic-write orphans in the data dir. */
function scanOrphanTempFiles(dataDir: string): OrphanTempFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch {
    return [];
  }
  const out: OrphanTempFile[] = [];
  for (const name of entries) {
    const m = name.match(/^ocr\.db\.(\d+)\.tmp$/);
    if (!m) continue;
    const pid = Number(m[1]);
    let ageMs = 0;
    try {
      ageMs = Date.now() - statSync(join(dataDir, name)).mtimeMs;
    } catch {
      continue;
    }
    const alive = isProcessAlive(pid);
    out.push({
      name,
      pid,
      ageMs,
      // Reapable only when the writer PID is dead AND the file is old enough
      // that no live mid-write could plausibly own it.
      reapable: !alive && ageMs > ONE_HOUR_MS,
    });
  }
  return out;
}

/** List `ocr.db.bak.*` snapshot files (legit backups + our pre-fix snapshots). */
function scanBackupFiles(dataDir: string, dbBase: string): BackupFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch {
    return [];
  }
  const out: BackupFile[] = [];
  for (const name of entries) {
    if (!name.startsWith(`${dbBase}.bak`)) continue;
    try {
      out.push({ name, sizeBytes: statSync(join(dataDir, name)).size });
    } catch {
      /* vanished mid-scan */
    }
  }
  return out.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

/**
 * Collect a full health report for an open database — pure reads, no mutation.
 * Safe to run against a live DB (e.g. while the dashboard is up).
 */
export function collectDbHealth(db: Database, dbPath: string): DbHealthReport {
  const dataDir = dirname(dbPath);
  const dbBase = basename(dbPath);

  const pageSize = scalarInt(db, "PRAGMA page_size");
  const pageCount = scalarInt(db, "PRAGMA page_count");
  const freelistCount = scalarInt(db, "PRAGMA freelist_count");

  const integ = db.exec("PRAGMA integrity_check");
  const integRows = (integ[0]?.values ?? []).map((v) => String(v[0]));
  const integrityOk = integRows.length === 1 && integRows[0] === "ok";

  const allGroups = foreignKeyViolationGroups(db);
  const fkViolations = allGroups.filter((g) => !PROTECTED_TABLES.has(g.table));
  const protectedFkViolations = allGroups.filter((g) =>
    PROTECTED_TABLES.has(g.table),
  );

  const fileSizeBytes = existsSync(dbPath) ? statSync(dbPath).size : 0;

  return {
    dbPath,
    fileSizeBytes,
    pageSize,
    pageCount,
    freelistCount,
    reclaimableBytes: freelistCount * pageSize,
    integrityOk,
    integrityErrors: integrityOk ? [] : integRows,
    fkViolations,
    protectedFkViolations,
    totalFkViolations: allGroups.reduce((n, g) => n + g.count, 0),
    markdownDuplicateRows: scalarInt(
      db,
      `SELECT COALESCE(SUM(cnt - 1), 0) FROM (
         SELECT COUNT(*) AS cnt FROM markdown_artifacts
          GROUP BY session_id, artifact_type, IFNULL(round_number, -1), file_path
         HAVING cnt > 1)`,
    ),
    orphanTempFiles: scanOrphanTempFiles(dataDir),
    backupFiles: scanBackupFiles(dataDir, dbBase),
    eventCount: scalarInt(db, "SELECT COUNT(*) FROM orchestration_events"),
    sessionCount: scalarInt(db, "SELECT COUNT(*) FROM sessions"),
  };
}

// ── Snapshot ──

/**
 * Best-effort point-in-time copy of the DB file before a mutating operation.
 * Checkpoints the WAL first so the snapshot is self-contained, then copies to
 * `<db>.bak.<label>.<iso>`. Returns the snapshot path, or null if it could not
 * be taken (callers decide whether that's fatal).
 */
export function snapshotDb(
  db: Database,
  dbPath: string,
  label = "doctor",
): string | null {
  try {
    if (!existsSync(dbPath) || statSync(dbPath).size === 0) return null;
    db.pragma("wal_checkpoint(TRUNCATE)");
    // Colon-free, filesystem-safe ISO stamp; sortable.
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const bakPath = `${dbPath}.bak.${label}.${ts}`;
    copyFileSync(dbPath, bakPath);
    return bakPath;
  } catch {
    return null;
  }
}

// ── Orphan temp reaping ──

/**
 * Reap `ocr.db.<pid>.tmp` atomic-write orphans from the retired sql.js engine.
 * Never touches the live DB set; only deletes temps whose PID is dead and whose
 * mtime is older than an hour. Returns the names it removed. Shared by the
 * dashboard's startup reaper and `ocr db doctor --fix`.
 */
export function reapOrphanDbFiles(dataDir: string): string[] {
  const reaped: string[] = [];
  for (const f of scanOrphanTempFiles(dataDir)) {
    if (!f.reapable) continue;
    try {
      unlinkSync(join(dataDir, f.name));
      reaped.push(f.name);
    } catch {
      /* best-effort */
    }
  }
  return reaped;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Reap stale per-execution agent log files (the file-stdio sink, one `<uid>.log`
 * per review). They are kept for post-mortem debugging but accumulate without
 * bound; delete those older than `maxAgeMs` (default 7 days). Returns the names
 * removed. Best-effort — a missing directory or unlink error is swallowed.
 */
export function reapStaleExecLogs(
  execLogsDir: string,
  maxAgeMs = SEVEN_DAYS_MS,
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(execLogsDir);
  } catch {
    return []; // dir doesn't exist yet — nothing to do
  }
  const cutoff = Date.now() - maxAgeMs;
  const reaped: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".log")) continue;
    const full = join(execLogsDir, name);
    try {
      if (statSync(full).mtimeMs > cutoff) continue;
      unlinkSync(full);
      reaped.push(name);
    } catch {
      /* best-effort */
    }
  }
  return reaped;
}

export type DbPruneBackupsResult = {
  dryRun: boolean;
  deleted: BackupFile[];
  kept: BackupFile[];
  reclaimedBytes: number;
};

/**
 * Prune `<db>.bak.*` snapshot files, retaining the `keep` most-recent (by mtime)
 * as a safety net and deleting the rest. Returns what was (or would be) removed
 * and the bytes reclaimed. `doctor` only reports backups — this is the explicit,
 * operator-driven way to reclaim that space (e.g. the 285 MB pre-remediation
 * snapshot once the database is confirmed healthy). `keep: 0` removes all.
 */
export function pruneBackups(
  dataDir: string,
  dbPath: string,
  opts: { keep?: number; dryRun?: boolean } = {},
): DbPruneBackupsResult {
  // Validate at the boundary, never clamp: `Math.max(0, NaN)` is NaN, and
  // NaN flows through `slice(0, NaN)`/`slice(NaN)` as "keep nothing, delete
  // everything" — the exact destructive outcome a malformed `keep` must not
  // produce (round-2 SF2). A non-integer/negative keep is a caller bug; throw.
  const keep = opts.keep ?? 1;
  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error(
      `pruneBackups: keep must be a non-negative integer (got ${String(keep)})`,
    );
  }
  const dryRun = opts.dryRun ?? false;
  const dbBase = basename(dbPath);

  // Build the backup list with mtime so "keep" retains the freshest snapshots.
  const withMtime: { file: BackupFile; mtimeMs: number }[] = [];
  for (const file of scanBackupFiles(dataDir, dbBase)) {
    try {
      withMtime.push({ file, mtimeMs: statSync(join(dataDir, file.name)).mtimeMs });
    } catch {
      /* vanished mid-scan */
    }
  }
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

  const kept = withMtime.slice(0, keep).map((x) => x.file);
  const toDelete = withMtime.slice(keep).map((x) => x.file);

  const deleted: BackupFile[] = [];
  if (!dryRun) {
    for (const b of toDelete) {
      try {
        unlinkSync(join(dataDir, b.name));
        deleted.push(b);
      } catch {
        /* best-effort */
      }
    }
  }

  const reported = dryRun ? toDelete : deleted;
  return {
    dryRun,
    deleted: reported,
    kept,
    reclaimedBytes: reported.reduce((n, b) => n + b.sizeBytes, 0),
  };
}

// ── Fix (doctor --fix) ──

export type DbFixOptions = {
  /** Snapshot before mutating (default true). */
  snapshot?: boolean;
  /** Reap orphan `*.tmp` files (default true). */
  reapTemps?: boolean;
  /** wal_checkpoint(TRUNCATE) + VACUUM at the end (default true). */
  vacuum?: boolean;
};

export type DbFixResult = {
  snapshotPath: string | null;
  fkOrphansDeleted: FkViolationGroup[];
  totalFkOrphansDeleted: number;
  /** Violations still present in protected tables (NOT auto-deleted). */
  protectedViolationsRemaining: FkViolationGroup[];
  markdownDupsDeleted: number;
  tempsReaped: string[];
  vacuumed: boolean;
  sizeBeforeBytes: number;
  sizeAfterBytes: number;
  integrityOkAfter: boolean;
  fkViolationsAfter: number;
};

/**
 * Repair a database: snapshot → FK-orphan sweep (FK off, ordered anti-joins, FK
 * on) → markdown dedup → orphan-temp reap → checkpoint + VACUUM. Protected
 * tables are never touched; their violations (if any) are reported back so an
 * operator can investigate. Returns a structured diff of everything it did.
 */
export function fixDb(
  db: Database,
  dbPath: string,
  opts: DbFixOptions = {},
): DbFixResult {
  const dataDir = dirname(dbPath);
  const sizeBeforeBytes = existsSync(dbPath) ? statSync(dbPath).size : 0;

  const snapshotPath =
    opts.snapshot === false ? null : snapshotDb(db, dbPath, "doctor");

  // ── FK-orphan sweep ──
  // With enforcement off (autocommit toggle via the shared helper), the ordered
  // anti-join deletes can remove orphans (and transitive orphans) without
  // tripping RESTRICT.
  const fkOrphansDeleted: FkViolationGroup[] = [];
  withForeignKeysDisabled(db, () => {
    db.transaction(() => {
      for (const sweep of ORPHAN_SWEEPS) {
        const info = db.prepare(sweep.sql).run();
        const count = Number(info.changes);
        if (count > 0) fkOrphansDeleted.push({ table: sweep.table, count });
      }
    });
  });

  // ── Markdown dedup (idempotent safety net) ──
  let markdownDupsDeleted = 0;
  db.transaction(() => {
    const info = db.prepare(MARKDOWN_DEDUP_SQL).run();
    markdownDupsDeleted = Number(info.changes);
  });

  // ── Orphan temp reap ──
  const tempsReaped =
    opts.reapTemps === false ? [] : reapOrphanDbFiles(dataDir);

  // ── Checkpoint + VACUUM ──
  let vacuumed = false;
  if (opts.vacuum !== false) {
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
      // VACUUM rewrites the whole file; it cannot run inside a transaction
      // (we are in autocommit here) and reclaims the freelist to the OS.
      db.run("VACUUM");
      vacuumed = true;
    } catch {
      vacuumed = false;
    }
  }

  const post = collectDbHealth(db, dbPath);
  return {
    snapshotPath,
    fkOrphansDeleted,
    totalFkOrphansDeleted: fkOrphansDeleted.reduce((n, g) => n + g.count, 0),
    protectedViolationsRemaining: post.protectedFkViolations,
    markdownDupsDeleted,
    tempsReaped,
    vacuumed,
    sizeBeforeBytes,
    sizeAfterBytes: post.fileSizeBytes,
    integrityOkAfter: post.integrityOk,
    fkViolationsAfter: post.totalFkViolations,
  };
}

// ── Vacuum (standalone) ──

export type DbVacuumResult = {
  snapshotPath: string | null;
  sizeBeforeBytes: number;
  sizeAfterBytes: number;
  reclaimedBytes: number;
};

/**
 * Checkpoint + in-place VACUUM, snapshot-first. Returns the bytes reclaimed.
 * The caller is responsible for ensuring no other writer holds the DB (the CLI
 * command refuses when a live dashboard owns it).
 */
export function vacuumDb(
  db: Database,
  dbPath: string,
  opts: { snapshot?: boolean } = {},
): DbVacuumResult {
  const sizeBeforeBytes = existsSync(dbPath) ? statSync(dbPath).size : 0;
  const snapshotPath =
    opts.snapshot === false ? null : snapshotDb(db, dbPath, "vacuum");
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.run("VACUUM");
  db.pragma("wal_checkpoint(TRUNCATE)");
  const sizeAfterBytes = existsSync(dbPath) ? statSync(dbPath).size : 0;
  return {
    snapshotPath,
    sizeBeforeBytes,
    sizeAfterBytes,
    reclaimedBytes: Math.max(0, sizeBeforeBytes - sizeAfterBytes),
  };
}

// ── Prune (retention) ──

export type DbPruneOptions = {
  /** Keep the N most-recently-created closed sessions' artifacts intact. */
  keepSessions?: number;
  /** Only prune closed sessions whose newest event is older than this. */
  olderThanDays?: number;
  /** Report the plan without deleting. */
  dryRun?: boolean;
};

export type DbPruneSessionPlan = {
  sessionId: string;
  /** Artifact rows that would be (or were) removed for this session. */
  artifactRows: number;
};

export type DbPruneResult = {
  dryRun: boolean;
  snapshotPath: string | null;
  prunedSessions: DbPruneSessionPlan[];
  totalArtifactRows: number;
};

/** Count the cascade-artifact rows currently attached to a session. Uses plain
 *  `?` placeholders (the id repeated once per subquery) to avoid relying on
 *  numbered-parameter reuse semantics across the binding layer. */
function countSessionArtifacts(db: Database, sessionId: string): number {
  const r = db.exec(
    `SELECT
       (SELECT COUNT(*) FROM markdown_artifacts WHERE session_id = ?) +
       (SELECT COUNT(*) FROM review_rounds      WHERE session_id = ?) +
       (SELECT COUNT(*) FROM reviewer_outputs ro JOIN review_rounds rr ON ro.round_id = rr.id WHERE rr.session_id = ?) +
       (SELECT COUNT(*) FROM review_findings rf JOIN reviewer_outputs ro ON rf.reviewer_output_id = ro.id JOIN review_rounds rr ON ro.round_id = rr.id WHERE rr.session_id = ?) +
       (SELECT COUNT(*) FROM map_runs           WHERE session_id = ?) +
       (SELECT COUNT(*) FROM chat_conversations WHERE session_id = ?)`,
    Array(6).fill(sessionId),
  );
  const v = r[0]?.values[0]?.[0];
  return typeof v === "number" ? v : Number(v ?? 0);
}

/**
 * Prune the cascade-artifact subtree of OLD CLOSED sessions, keeping the
 * `sessions` row and ALL `orchestration_events` (the immutable system of
 * record) intact. A pruned session remains fully auditable from its events; it
 * just no longer carries its bulky derived artifacts.
 *
 * Selection requires at least one bound (`olderThanDays` or `keepSessions`);
 * with neither, nothing is pruned (no accidental mass delete). Deletes rely on
 * `ON DELETE CASCADE` from the parent rows, so removing `review_rounds`,
 * `map_runs`, `markdown_artifacts`, and `chat_conversations` for a session
 * reaps the whole subtree.
 */
export function pruneDb(
  db: Database,
  dbPath: string,
  opts: DbPruneOptions = {},
): DbPruneResult {
  const dryRun = opts.dryRun ?? false;
  const hasBound =
    opts.olderThanDays !== undefined || opts.keepSessions !== undefined;
  if (!hasBound) {
    return { dryRun, snapshotPath: null, prunedSessions: [], totalArtifactRows: 0 };
  }

  // Closed sessions, newest-event first. `keepSessions` protects the N most
  // recent; `olderThanDays` bounds by event recency. Both bounds, when given,
  // must hold (a session is eligible only if old AND outside the keep window).
  const rows = db.exec(
    `SELECT s.id,
            (SELECT (julianday('now') - julianday(MAX(e.created_at))) * 86400
               FROM orchestration_events e WHERE e.session_id = s.id) AS quiet_seconds
       FROM sessions s
      WHERE s.status = 'closed'
      ORDER BY quiet_seconds ASC`,
  );
  const closed = (rows[0]?.values ?? []).map((v) => ({
    id: String(v[0]),
    quietSeconds: typeof v[1] === "number" ? v[1] : Number(v[1] ?? 0),
  }));

  const keepN = opts.keepSessions ?? 0;
  const olderThanSeconds =
    opts.olderThanDays !== undefined ? opts.olderThanDays * 86400 : null;

  const targets = closed.filter((s, idx) => {
    if (idx < keepN) return false; // protected: among the N most recent
    if (olderThanSeconds !== null && s.quietSeconds < olderThanSeconds)
      return false;
    return true;
  });

  const prunedSessions: DbPruneSessionPlan[] = [];
  for (const t of targets) {
    const artifactRows = countSessionArtifacts(db, t.id);
    if (artifactRows === 0) continue; // already bare — skip
    prunedSessions.push({ sessionId: t.id, artifactRows });
  }

  if (dryRun || prunedSessions.length === 0) {
    return {
      dryRun,
      snapshotPath: null,
      prunedSessions,
      totalArtifactRows: prunedSessions.reduce((n, p) => n + p.artifactRows, 0),
    };
  }

  const snapshotPath = snapshotDb(db, dbPath, "prune");
  db.transaction(() => {
    for (const p of prunedSessions) {
      // CASCADE does the subtree; events + the session row are untouched.
      db.run("DELETE FROM review_rounds WHERE session_id = ?", [p.sessionId]);
      db.run("DELETE FROM map_runs WHERE session_id = ?", [p.sessionId]);
      db.run("DELETE FROM markdown_artifacts WHERE session_id = ?", [p.sessionId]);
      db.run("DELETE FROM chat_conversations WHERE session_id = ?", [p.sessionId]);
    }
  });

  return {
    dryRun,
    snapshotPath,
    prunedSessions,
    totalArtifactRows: prunedSessions.reduce((n, p) => n + p.artifactRows, 0),
  };
}
