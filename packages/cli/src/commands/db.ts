/**
 * OCR Database Maintenance Command — `ocr db doctor / prune / vacuum`.
 *
 * Operator-facing hygiene for the SQLite store. The migration runner self-heals
 * a database on upgrade; these subcommands make the same primitives available
 * on demand, with reporting, snapshots, and a dry-run for retention:
 *
 *   doctor [--fix]  — report size / freelist / integrity / FK violations /
 *                     markdown dups / orphan temps + backups; `--fix` runs the
 *                     snapshot → FK-orphan sweep → dedup → temp reap → VACUUM.
 *   vacuum          — checkpoint + in-place VACUUM (snapshot-first).
 *   prune           — drop the cascade-artifact subtree of OLD CLOSED sessions
 *                     (never events or the session row); --dry-run shows the plan.
 *
 * The mutating paths that take an exclusive lock (`vacuum`, `doctor --fix`)
 * refuse when a live dashboard owns the database, unless `--force`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { isProcessAlive } from "@open-code-review/platform";
import { requireOcrSetup } from "../lib/guards.js";
import {
  ensureDatabase,
  collectDbHealth,
  fixDb,
  vacuumDb,
  pruneDb,
  pruneBackups,
  type DbHealthReport,
} from "@open-code-review/persistence";

function fail(message: string): never {
  console.error(chalk.red(`Error: ${message}`));
  process.exit(1);
}

function resolveOcrDir(): string {
  const targetDir = process.cwd();
  requireOcrSetup(targetDir);
  return join(targetDir, ".ocr");
}

function dbPathFor(ocrDir: string): string {
  return join(ocrDir, "data", "ocr.db");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/**
 * Refuse a lock-taking operation while a live dashboard owns the DB. An
 * in-place VACUUM needs exclusive access; coexisting with the dashboard's WAL
 * connection risks SQLITE_BUSY mid-rewrite. Returns the live PID or null.
 */
function liveDashboardPid(ocrDir: string): number | null {
  const pidFile = join(ocrDir, "data", "dashboard.pid");
  if (!existsSync(pidFile)) return null;
  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (!Number.isNaN(pid) && isProcessAlive(pid)) return pid;
  } catch {
    /* unreadable pid file — treat as no live dashboard */
  }
  return null;
}

function guardExclusive(ocrDir: string, force: boolean, op: string): void {
  const pid = liveDashboardPid(ocrDir);
  if (pid !== null && !force) {
    fail(
      `a dashboard appears to be running (PID ${pid}); ${op} needs exclusive ` +
        `access to the database.\n  Stop it first, or pass --force to proceed anyway.`,
    );
  }
}

// ── Reporting ──

function printHealth(report: DbHealthReport): void {
  console.log();
  console.log(chalk.bold("  Database Health"));
  console.log();
  console.log(`    File:        ${report.dbPath}`);
  console.log(`    Size:        ${formatBytes(report.fileSizeBytes)}`);
  if (report.reclaimableBytes > 0) {
    console.log(
      `    Reclaimable: ${chalk.yellow(formatBytes(report.reclaimableBytes))} ` +
        chalk.dim(`(${report.freelistCount} free pages — run \`ocr db vacuum\`)`),
    );
  }
  console.log(
    `    Records:     ${report.sessionCount} session(s), ${report.eventCount} event(s)`,
  );

  console.log();
  const ok = (s: string) => `    ${chalk.green("✓")} ${s}`;
  const bad = (s: string) => `    ${chalk.red("✗")} ${s}`;

  console.log(
    report.integrityOk
      ? ok("integrity_check: ok")
      : bad(`integrity_check: ${report.integrityErrors.length} error(s)`),
  );
  if (!report.integrityOk) {
    for (const e of report.integrityErrors.slice(0, 5)) {
      console.log(`        ${chalk.dim(e)}`);
    }
  }

  const fkTotal =
    report.fkViolations.reduce((n, g) => n + g.count, 0) +
    report.protectedFkViolations.reduce((n, g) => n + g.count, 0);
  if (fkTotal === 0) {
    console.log(ok("foreign_key_check: 0 violations"));
  } else {
    console.log(bad(`foreign_key_check: ${fkTotal} violation(s)`));
    for (const g of report.fkViolations) {
      console.log(`        ${chalk.dim(`${g.table}: ${g.count} orphan(s)`)}`);
    }
    for (const g of report.protectedFkViolations) {
      console.log(
        `        ${chalk.yellow(`${g.table}: ${g.count} (protected — manual review)`)}`,
      );
    }
  }

  if (report.markdownDuplicateRows === 0) {
    console.log(ok("markdown_artifacts: no duplicates"));
  } else {
    console.log(
      bad(`markdown_artifacts: ${report.markdownDuplicateRows} duplicate row(s)`),
    );
  }

  const reapable = report.orphanTempFiles.filter((f) => f.reapable);
  if (report.orphanTempFiles.length > 0) {
    console.log(
      `    ${reapable.length > 0 ? chalk.yellow("⚠") : chalk.dim("·")} ` +
        `orphan temp files: ${report.orphanTempFiles.length} ` +
        `(${reapable.length} reapable)`,
    );
  }
  if (report.backupFiles.length > 0) {
    const total = report.backupFiles.reduce((n, b) => n + b.sizeBytes, 0);
    console.log(
      `    ${chalk.dim("·")} backups: ${report.backupFiles.length} ` +
        `(${formatBytes(total)})`,
    );
  }
  console.log();
}

function needsFix(report: DbHealthReport): boolean {
  return (
    !report.integrityOk ||
    report.fkViolations.length > 0 ||
    report.markdownDuplicateRows > 0 ||
    report.orphanTempFiles.some((f) => f.reapable) ||
    report.reclaimableBytes > 0
  );
}

// ── doctor ──

const doctorSubcommand = new Command("doctor")
  .description("Report database health; --fix repairs orphans/dupes and VACUUMs")
  .option("--fix", "apply repairs: FK-orphan sweep, dedup, temp reap, VACUUM")
  .option("--no-snapshot", "skip the pre-fix snapshot (with --fix)")
  .option("--force", "proceed even if a live dashboard owns the database")
  .option("--json", "emit the health report as JSON (implies no --fix)")
  .action(
    async (options: {
      fix?: boolean;
      snapshot?: boolean;
      force?: boolean;
      json?: boolean;
    }) => {
      const ocrDir = resolveOcrDir();
      const dbPath = dbPathFor(ocrDir);
      const db = await ensureDatabase(ocrDir);

      if (options.json) {
        console.log(JSON.stringify(collectDbHealth(db, dbPath), null, 2));
        return;
      }

      const before = collectDbHealth(db, dbPath);
      printHealth(before);

      if (!options.fix) {
        if (needsFix(before)) {
          console.log(
            chalk.dim("  Run `ocr db doctor --fix` to repair the issues above."),
          );
          console.log();
        } else {
          console.log(chalk.green("  ✓ Database is healthy"));
          console.log();
        }
        return;
      }

      guardExclusive(ocrDir, options.force ?? false, "doctor --fix");

      const result = fixDb(db, dbPath, { snapshot: options.snapshot !== false });

      console.log(chalk.bold("  Repairs applied"));
      console.log();
      if (result.snapshotPath) {
        console.log(`    ${chalk.dim("snapshot:")} ${result.snapshotPath}`);
      }
      if (result.totalFkOrphansDeleted > 0) {
        console.log(
          `    ${chalk.green("✓")} swept ${result.totalFkOrphansDeleted} FK-orphan row(s)`,
        );
        for (const g of result.fkOrphansDeleted) {
          console.log(`        ${chalk.dim(`${g.table}: ${g.count}`)}`);
        }
      }
      if (result.markdownDupsDeleted > 0) {
        console.log(
          `    ${chalk.green("✓")} removed ${result.markdownDupsDeleted} duplicate markdown row(s)`,
        );
      }
      if (result.tempsReaped.length > 0) {
        console.log(
          `    ${chalk.green("✓")} reaped ${result.tempsReaped.length} orphan temp file(s)`,
        );
      }
      if (result.vacuumed) {
        const saved = result.sizeBeforeBytes - result.sizeAfterBytes;
        console.log(
          `    ${chalk.green("✓")} VACUUM: ${formatBytes(result.sizeBeforeBytes)} → ` +
            `${formatBytes(result.sizeAfterBytes)} ` +
            chalk.dim(`(reclaimed ${formatBytes(Math.max(0, saved))})`),
        );
      }
      console.log();

      if (result.protectedViolationsRemaining.length > 0) {
        console.log(
          chalk.yellow(
            "  ⚠ Violations remain in protected (system-of-record) tables:",
          ),
        );
        for (const g of result.protectedViolationsRemaining) {
          console.log(`        ${chalk.yellow(`${g.table}: ${g.count}`)}`);
        }
        console.log();
      }

      if (result.integrityOkAfter && result.fkViolationsAfter === 0) {
        console.log(chalk.green("  ✓ Database repaired and healthy"));
      } else {
        console.log(
          chalk.red(
            `  ✗ Post-fix check: integrity ${result.integrityOkAfter ? "ok" : "FAILED"}, ` +
              `${result.fkViolationsAfter} FK violation(s) remaining`,
          ),
        );
        process.exitCode = 1;
      }
      console.log();
    },
  );

// ── vacuum ──

const vacuumSubcommand = new Command("vacuum")
  .description("Checkpoint the WAL and VACUUM the database (snapshot-first)")
  .option("--no-snapshot", "skip the pre-vacuum snapshot")
  .option("--force", "proceed even if a live dashboard owns the database")
  .action(async (options: { snapshot?: boolean; force?: boolean }) => {
    const ocrDir = resolveOcrDir();
    const dbPath = dbPathFor(ocrDir);
    guardExclusive(ocrDir, options.force ?? false, "vacuum");

    const db = await ensureDatabase(ocrDir);
    const result = vacuumDb(db, dbPath, { snapshot: options.snapshot !== false });

    console.log();
    if (result.snapshotPath) {
      console.log(`    ${chalk.dim("snapshot:")} ${result.snapshotPath}`);
    }
    console.log(
      `    ${chalk.green("✓")} VACUUM: ${formatBytes(result.sizeBeforeBytes)} → ` +
        `${formatBytes(result.sizeAfterBytes)} ` +
        chalk.dim(`(reclaimed ${formatBytes(result.reclaimedBytes)})`),
    );
    console.log();
  });

// ── prune ──

const pruneSubcommand = new Command("prune")
  .description(
    "Drop derived artifacts of old CLOSED sessions (events + sessions kept)",
  )
  .option(
    "--keep-sessions <n>",
    "protect the N most-recently-active closed sessions",
    (v) => parseInt(v, 10),
  )
  .option(
    "--older-than <days>",
    "only prune closed sessions quiet for more than D days",
    (v) => parseInt(v, 10),
  )
  .option("--dry-run", "show what would be pruned without deleting")
  .option("--force", "proceed even if a live dashboard owns the database")
  .action(
    async (options: {
      keepSessions?: number;
      olderThan?: number;
      dryRun?: boolean;
      force?: boolean;
    }) => {
      const ocrDir = resolveOcrDir();
      const dbPath = dbPathFor(ocrDir);

      if (options.keepSessions === undefined && options.olderThan === undefined) {
        fail(
          "prune needs a bound: pass --older-than <days> and/or --keep-sessions <n>.",
        );
      }
      if (!options.dryRun) {
        guardExclusive(ocrDir, options.force ?? false, "prune");
      }

      const db = await ensureDatabase(ocrDir);
      const result = pruneDb(db, dbPath, {
        keepSessions: options.keepSessions,
        olderThanDays: options.olderThan,
        dryRun: options.dryRun ?? false,
      });

      console.log();
      if (result.prunedSessions.length === 0) {
        console.log(chalk.green("  ✓ Nothing to prune"));
        console.log();
        return;
      }

      const verb = result.dryRun ? "Would prune" : "Pruned";
      console.log(
        chalk.bold(
          `  ${verb} ${result.totalArtifactRows} artifact row(s) across ` +
            `${result.prunedSessions.length} session(s)`,
        ),
      );
      console.log();
      for (const p of result.prunedSessions.slice(0, 20)) {
        console.log(
          `    ${chalk.dim("·")} ${p.sessionId} ${chalk.dim(`(${p.artifactRows} rows)`)}`,
        );
      }
      if (result.prunedSessions.length > 20) {
        console.log(
          `    ${chalk.dim(`… and ${result.prunedSessions.length - 20} more`)}`,
        );
      }
      console.log();
      if (result.snapshotPath) {
        console.log(`    ${chalk.dim("snapshot:")} ${result.snapshotPath}`);
      }
      console.log(
        chalk.dim(
          result.dryRun
            ? "  Re-run without --dry-run to apply. Events + session rows are always kept."
            : "  Events + session rows were kept; sessions remain fully auditable.",
        ),
      );
      console.log();
    },
  );

// ── prune-backups ──

/**
 * Validate `prune-backups` options at the CLI boundary. Returns an error
 * message, or null when the combination is safe to execute.
 *
 * Exported pure so the rejection table is unit-testable. Two layers:
 *  1. `keep` must be a non-negative INTEGER. `parseInt('oops')` is NaN, and
 *     `NaN <= 0` is false — so without this check a typo would sail past the
 *     `--force` guard and delete every backup (round-2 SF2). Validate, never
 *     coerce.
 *  2. `--keep 0` removes ALL snapshots — including a fresh `doctor --fix` /
 *     `vacuum` safety net — so it requires `--force` (a dry-run is always
 *     allowed for previewing). Round-1 S12.
 */
export function validatePruneBackupsOptions(options: {
  keep: number;
  force?: boolean;
  dryRun?: boolean;
}): string | null {
  if (!Number.isInteger(options.keep) || options.keep < 0) {
    return `--keep must be a non-negative integer (got "${String(options.keep)}").`;
  }
  if (options.keep === 0 && !options.force && !options.dryRun) {
    return (
      "--keep 0 removes every backup (including any just-written snapshot). " +
      "Re-run with --dry-run to preview, or --force to confirm."
    );
  }
  return null;
}

const pruneBackupsSubcommand = new Command("prune-backups")
  .description("Delete old ocr.db.bak.* snapshots, keeping the most recent few")
  .option(
    "--keep <n>",
    "retain the N most-recent backups (default 1; 0 removes all, requires --force)",
    // Raw conversion only — `Number('oops')` is NaN and flows into
    // validatePruneBackupsOptions, the single validation home. (parseInt would
    // also silently accept "3abc" → 3; Number rejects it as NaN.)
    (v) => Number(v),
    1,
  )
  .option("--force", "permit --keep 0 (removing the last backup / safety net)")
  .option("--dry-run", "show what would be deleted without deleting")
  .action(async (options: { keep: number; force?: boolean; dryRun?: boolean }) => {
    const ocrDir = resolveOcrDir();
    const dataDir = join(ocrDir, "data");

    const invalid = validatePruneBackupsOptions(options);
    if (invalid !== null) {
      fail(invalid);
    }

    // Pure file hygiene — no DB lock, so no live-dashboard guard needed.
    const result = pruneBackups(dataDir, dbPathFor(ocrDir), {
      keep: options.keep,
      dryRun: options.dryRun ?? false,
    });

    console.log();
    if (result.deleted.length === 0) {
      console.log(chalk.green("  ✓ No backups to remove"));
      console.log();
      return;
    }
    const verb = result.dryRun ? "Would delete" : "Deleted";
    console.log(
      chalk.bold(
        `  ${verb} ${result.deleted.length} backup(s) — ${formatBytes(result.reclaimedBytes)}`,
      ),
    );
    console.log();
    for (const b of result.deleted) {
      console.log(`    ${chalk.dim("·")} ${b.name} ${chalk.dim(`(${formatBytes(b.sizeBytes)})`)}`);
    }
    if (result.kept.length > 0) {
      console.log();
      console.log(
        chalk.dim(`  Kept ${result.kept.length} most-recent backup(s) as a safety net.`),
      );
    }
    console.log();
  });

export const dbCommand = new Command("db")
  .description("Inspect and maintain the OCR SQLite database")
  .addCommand(doctorSubcommand)
  .addCommand(vacuumSubcommand)
  .addCommand(pruneSubcommand)
  .addCommand(pruneBackupsSubcommand);
