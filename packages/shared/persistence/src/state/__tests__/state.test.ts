import { mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { makeTempWorkspace, removeTempWorkspace } from "../../db/test-support.js";
import {
  stateInit,
  stateTransition,
  stateClose,
  stateShow,
  stateList,
  stateSync,
  stateBegin,
  stateAdvance,
  stateCompleteRound,
  stateCompleteMap,
  computeRoundCounts,
  computeMapCounts,
  validateRoundMeta,
  validateMapMeta,
  resolveActiveSession,
  STATE_EXIT,
} from "../index.js";
import type { RoundMeta, MapMeta } from "../types.js";

let tmpDir: string;
let ocrDir: string;
let sessionsDir: string;

beforeEach(() => {
  tmpDir = makeTempWorkspace("ocr-state-test-");
  ocrDir = join(tmpDir, ".ocr");
  sessionsDir = join(ocrDir, "sessions");
});

afterEach(() => {
  removeTempWorkspace(tmpDir);
});

function sessionDir(sessionId: string): string {
  const dir = join(sessionsDir, sessionId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Begin a review session and walk it to `synthesis` — the phase the atomic
 * `stateCompleteRound` enforces as proof-of-work before it will finalize a
 * round. Returns the session directory.
 */
async function beginReviewAtSynthesis(sessionId: string): Promise<string> {
  const dir = sessionDir(sessionId);
  await stateBegin({
    sessionId,
    branch: "feat/x",
    workflowType: "review",
    sessionDir: dir,
    ocrDir,
  });
  for (const phase of [
    "change-context",
    "analysis",
    "reviews",
    "aggregation",
    "discourse",
    "synthesis",
  ]) {
    await stateAdvance({ sessionId, phase, ocrDir });
  }
  return dir;
}

/**
 * Begin a map session and walk it to `synthesis` — the phase the atomic
 * `stateCompleteMap` enforces as proof-of-work before it will finalize a run.
 */
async function beginMapAtSynthesis(sessionId: string): Promise<string> {
  const dir = sessionDir(sessionId);
  await stateBegin({
    sessionId,
    branch: "feat/x",
    workflowType: "map",
    sessionDir: dir,
    ocrDir,
  });
  for (const phase of [
    "topology",
    "flow-analysis",
    "requirements-mapping",
    "synthesis",
  ]) {
    await stateAdvance({ sessionId, phase, ocrDir });
  }
  return dir;
}

describe("stateInit", () => {
  it("creates a session in SQLite and returns the session ID", async () => {
    const dir = sessionDir("test-session");
    const result = await stateInit({
      sessionId: "test-session",
      branch: "feat/test",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });

    expect(result).toBe("test-session");
  });

  it("persists session data in SQLite", async () => {
    const dir = sessionDir("persist-test");
    await stateInit({
      sessionId: "persist-test",
      branch: "feat/persist",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });

    const result = await stateShow(ocrDir, "persist-test");
    expect(result).not.toBeNull();
    expect(result?.session.id).toBe("persist-test");
    expect(result?.session.status).toBe("active");
    expect(result?.session.workflow_type).toBe("review");
    expect(result?.session.current_phase).toBe("context");
    expect(result?.session.phase_number).toBe(1);
    expect(result?.session.current_round).toBe(1);
    expect(result?.session.current_map_run).toBe(1);
  });

  it("inserts a session_created event", async () => {
    const dir = sessionDir("event-test");
    await stateInit({
      sessionId: "event-test",
      branch: "feat/events",
      workflowType: "map",
      sessionDir: dir,
      ocrDir,
    });

    const result = await stateShow(ocrDir, "event-test");
    expect(result).not.toBeNull();
    expect(result?.events).toHaveLength(1);
    expect(result?.events[0]?.event_type).toBe("session_created");
  });

  it("creates the database file", async () => {
    const dir = sessionDir("db-create");
    await stateInit({
      sessionId: "db-create",
      branch: "main",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });

    expect(existsSync(join(ocrDir, "data", "ocr.db"))).toBe(true);
  });

  it("supports map workflow type", async () => {
    const dir = sessionDir("map-session");
    await stateInit({
      sessionId: "map-session",
      branch: "feat/map",
      workflowType: "map",
      sessionDir: dir,
      ocrDir,
    });

    const result = await stateShow(ocrDir, "map-session");
    expect(result?.session.workflow_type).toBe("map");
  });
});

describe("stateTransition", () => {
  it("transitions phase in SQLite", async () => {
    const dir = sessionDir("transition-test");
    await stateInit({
      sessionId: "transition-test",
      branch: "feat/trans",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });

    await stateTransition({
      sessionId: "transition-test",
      phase: "change-context",
      phaseNumber: 2,
      ocrDir,
    });

    const result = await stateShow(ocrDir, "transition-test");
    expect(result?.session.current_phase).toBe("change-context");
    expect(result?.session.phase_number).toBe(2);
  });

  it("inserts a phase_transition event", async () => {
    const dir = sessionDir("phase-event");
    await stateInit({
      sessionId: "phase-event",
      branch: "feat/pe",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });

    // Walk through legal phases (the graph rejects context → analysis).
    await stateTransition({
      sessionId: "phase-event",
      phase: "change-context",
      phaseNumber: 2,
      ocrDir,
    });
    await stateTransition({
      sessionId: "phase-event",
      phase: "analysis",
      phaseNumber: 3,
      ocrDir,
    });

    const result = await stateShow(ocrDir, "phase-event");
    const events = result?.events ?? [];
    const transitionEvent = events.find(
      (e) => e.event_type === "phase_transition" && e.phase === "analysis",
    );
    expect(transitionEvent).toBeDefined();
    expect(transitionEvent?.phase).toBe("analysis");
    expect(transitionEvent?.phase_number).toBe(3);
  });

  it("inserts a round_started event when round changes", async () => {
    const dir = sessionDir("round-change");
    await stateInit({
      sessionId: "round-change",
      branch: "feat/rc",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });

    await stateTransition({
      sessionId: "round-change",
      phase: "context",
      phaseNumber: 1,
      round: 2,
      ocrDir,
    });

    const result = await stateShow(ocrDir, "round-change");
    const events = result?.events ?? [];
    const roundEvent = events.find((e) => e.event_type === "round_started");
    expect(roundEvent).toBeDefined();
    expect(roundEvent?.round).toBe(2);
  });

  it("does not insert round_started when round stays the same", async () => {
    const dir = sessionDir("no-round-event");
    await stateInit({
      sessionId: "no-round-event",
      branch: "feat/nre",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });

    await stateTransition({
      sessionId: "no-round-event",
      phase: "change-context",
      phaseNumber: 2,
      round: 1, // same round
      ocrDir,
    });

    const result = await stateShow(ocrDir, "no-round-event");
    const events = result?.events ?? [];
    const roundEvent = events.find((e) => e.event_type === "round_started");
    expect(roundEvent).toBeUndefined();
  });

  it("throws if session does not exist", async () => {
    // Ensure DB exists
    const dir = sessionDir("exists-first");
    await stateInit({
      sessionId: "exists-first",
      branch: "main",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });

    await expect(
      stateTransition({
        sessionId: "nonexistent",
        phase: "context",
        phaseNumber: 1,
        ocrDir,
      }),
    ).rejects.toThrow("Session not found: nonexistent");
  });

  it("supports multiple sequential transitions", async () => {
    const dir = sessionDir("multi-trans");
    await stateInit({
      sessionId: "multi-trans",
      branch: "feat/mt",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });

    const phases = [
      { phase: "change-context", phaseNumber: 2 },
      { phase: "analysis", phaseNumber: 3 },
      { phase: "reviews", phaseNumber: 4 },
      { phase: "aggregation", phaseNumber: 5 },
      { phase: "discourse", phaseNumber: 6 },
      { phase: "synthesis", phaseNumber: 7 },
    ];

    for (const p of phases) {
      await stateTransition({
        sessionId: "multi-trans",
        phase: p.phase as import("../../state/types.js").ReviewPhase,
        phaseNumber: p.phaseNumber,
        ocrDir,
      });
    }

    const result = await stateShow(ocrDir, "multi-trans");
    expect(result?.session.current_phase).toBe("synthesis");
    expect(result?.session.phase_number).toBe(7);
    // 1 session_created + 6 phase_transitions = 7 events
    expect(result?.events).toHaveLength(7);
  });
});

describe("stateClose", () => {
  it("marks session as closed in SQLite", async () => {
    const dir = sessionDir("close-test");
    await stateInit({
      sessionId: "close-test",
      branch: "feat/close",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });

    // No completed round — abort is the legitimate way to close it.
    await stateClose({
      sessionId: "close-test",
      ocrDir,
      abort: true,
    });

    const result = await stateShow(ocrDir, "close-test");
    expect(result?.session.status).toBe("closed");
    expect(result?.session.current_phase).toBe("complete");
  });

  it("inserts a session_closed event", async () => {
    await beginReviewAtSynthesis("close-event");

    // Finalize a round so a normal (non-abort) close is permitted.
    await stateCompleteRound({
      source: "stdin",
      ocrDir,
      sessionId: "close-event",
      data: JSON.stringify({ schema_version: 1, verdict: "APPROVE", reviewers: [] }),
    });
    await stateClose({
      sessionId: "close-event",
      ocrDir,
    });

    const result = await stateShow(ocrDir, "close-event");
    const events = result?.events ?? [];
    const closeEvent = events.find((e) => e.event_type === "session_closed");
    expect(closeEvent).toBeDefined();
    expect(closeEvent?.phase).toBe("complete");
  });

  it("throws if session does not exist", async () => {
    const dir = sessionDir("close-noexist");
    await stateInit({
      sessionId: "close-noexist",
      branch: "main",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });

    await expect(
      stateClose({
        sessionId: "ghost",
        ocrDir,
      }),
    ).rejects.toThrow("Session not found: ghost");
  });
});

describe("stateShow", () => {
  it("returns latest active session when no ID given", async () => {
    const dir1 = sessionDir("show-s1");
    const dir2 = sessionDir("show-s2");

    await stateInit({
      sessionId: "show-s1",
      branch: "feat/a",
      workflowType: "review",
      sessionDir: dir1,
      ocrDir,
    });

    await stateInit({
      sessionId: "show-s2",
      branch: "feat/b",
      workflowType: "map",
      sessionDir: dir2,
      ocrDir,
    });

    const result = await stateShow(ocrDir);
    expect(result).not.toBeNull();
    expect(result?.session.status).toBe("active");
  });

  it("returns specific session by ID", async () => {
    const dir = sessionDir("specific");
    await stateInit({
      sessionId: "specific",
      branch: "feat/spec",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });

    const result = await stateShow(ocrDir, "specific");
    expect(result?.session.id).toBe("specific");
  });

  it("returns null when no sessions exist", async () => {
    // Just ensure the DB exists with no sessions
    const dir = sessionDir("temp");
    await stateInit({
      sessionId: "temp",
      branch: "main",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });
    await stateClose({
      sessionId: "temp",
      ocrDir,
      abort: true,
    });

    // No active sessions now
    const result = await stateShow(ocrDir);
    expect(result).toBeNull();
  });

  it("includes recent events in the result", async () => {
    const dir = sessionDir("events-show");
    await stateInit({
      sessionId: "events-show",
      branch: "feat/ev",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });

    // Walk a legal edge (context → change-context).
    await stateTransition({
      sessionId: "events-show",
      phase: "change-context",
      phaseNumber: 2,
      ocrDir,
    });

    const result = await stateShow(ocrDir, "events-show");
    expect(result?.events.length).toBeGreaterThanOrEqual(2);
  });
});

describe("stateList", () => {
  it("returns all sessions", async () => {
    const dir1 = sessionDir("list-1");
    const dir2 = sessionDir("list-2");

    await stateInit({
      sessionId: "list-1",
      branch: "feat/a",
      workflowType: "review",
      sessionDir: dir1,
      ocrDir,
    });
    await stateInit({
      sessionId: "list-2",
      branch: "feat/b",
      workflowType: "map",
      sessionDir: dir2,
      ocrDir,
    });

    const sessions = await stateList(ocrDir);
    expect(sessions).toHaveLength(2);
  });

  it("returns empty array when no sessions", async () => {
    const sessions = await stateList(ocrDir);
    expect(sessions).toHaveLength(0);
  });
});

describe("stateSync", () => {
  it("backfills sessions from filesystem into SQLite", async () => {
    // Create a session dir with filesystem artifacts but no SQLite row
    const dir = join(sessionsDir, "2026-03-04-feat-legacy");
    const reviewsDir = join(dir, "rounds", "round-1", "reviews");
    mkdirSync(reviewsDir, { recursive: true });
    writeFileSync(join(reviewsDir, "principal-1.md"), "# Review\n");

    const synced = await stateSync(ocrDir);
    expect(synced).toBe(1);

    // Verify backfilled in SQLite
    const result = await stateShow(ocrDir, "2026-03-04-feat-legacy");
    expect(result).not.toBeNull();
    expect(result?.session.branch).toBe("feat-legacy");
    expect(result?.session.workflow_type).toBe("review");
    expect(result?.session.status).toBe("closed");
  });

  it("infers 'complete' phase when final.md exists", async () => {
    const dir = join(sessionsDir, "2026-03-04-feat-complete");
    const roundDir = join(dir, "rounds", "round-1");
    mkdirSync(roundDir, { recursive: true });
    writeFileSync(join(roundDir, "final.md"), "# Final Review\n");

    await stateSync(ocrDir);

    const result = await stateShow(ocrDir, "2026-03-04-feat-complete");
    expect(result?.session.current_phase).toBe("complete");
    expect(result?.session.status).toBe("closed");
  });

  it("defaults to 'context' phase when no final.md exists", async () => {
    const dir = join(sessionsDir, "2026-03-04-feat-incomplete");
    const reviewsDir = join(dir, "rounds", "round-1", "reviews");
    mkdirSync(reviewsDir, { recursive: true });
    writeFileSync(join(reviewsDir, "principal-1.md"), "# Review\n");

    await stateSync(ocrDir);

    const result = await stateShow(ocrDir, "2026-03-04-feat-incomplete");
    expect(result?.session.current_phase).toBe("context");
    expect(result?.session.status).toBe("closed");
  });

  it("skips sessions that already exist in SQLite", async () => {
    const dir = sessionDir("already-exists");
    await stateInit({
      sessionId: "already-exists",
      branch: "feat/ae",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });

    const synced = await stateSync(ocrDir);
    expect(synced).toBe(0);
  });

  it("skips empty directories with no artifacts", async () => {
    const dir = join(sessionsDir, "empty-dir");
    mkdirSync(dir, { recursive: true });

    const synced = await stateSync(ocrDir);
    expect(synced).toBe(0);
  });

  it("detects map workflow from filesystem structure", async () => {
    const dir = join(sessionsDir, "2026-03-04-feat-map-test");
    const runDir = join(dir, "map", "runs", "run-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "topology.md"), "# Topology\n");

    const synced = await stateSync(ocrDir);
    expect(synced).toBe(1);

    const result = await stateShow(ocrDir, "2026-03-04-feat-map-test");
    expect(result?.session.workflow_type).toBe("map");
  });

  it("inserts a session_synced event for backfilled sessions", async () => {
    const dir = join(sessionsDir, "synced-events");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "context.md"), "# Context\n");

    await stateSync(ocrDir);

    const result = await stateShow(ocrDir, "synced-events");
    const syncEvent = result?.events.find(
      (e) => e.event_type === "session_synced",
    );
    expect(syncEvent).toBeDefined();
    expect(syncEvent?.metadata).toContain("filesystem_backfill");
  });

  it("syncs multiple sessions at once", async () => {
    for (let i = 1; i <= 3; i++) {
      const dir = join(sessionsDir, `multi-sync-${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "context.md"), "# Context\n");
    }

    const synced = await stateSync(ocrDir);
    expect(synced).toBe(3);

    const sessions = await stateList(ocrDir);
    expect(sessions).toHaveLength(3);
  });

  it("returns 0 when sessions directory does not exist", async () => {
    const synced = await stateSync(ocrDir);
    expect(synced).toBe(0);
  });
});

describe("resolveActiveSession", () => {
  it("returns the latest active session", async () => {
    const dir = sessionDir("active-resolve");
    await stateInit({
      sessionId: "active-resolve",
      branch: "feat/ar",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });

    const result = await resolveActiveSession(ocrDir);
    expect(result.id).toBe("active-resolve");
    expect(result.sessionDir).toBe(dir);
  });

  it("throws when no active session exists", async () => {
    const dir = sessionDir("closed-resolve");
    await stateInit({
      sessionId: "closed-resolve",
      branch: "feat/cr",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });
    await stateClose({
      sessionId: "closed-resolve",
      ocrDir,
      abort: true,
    });

    await expect(resolveActiveSession(ocrDir)).rejects.toThrow(
      "No active session found",
    );
  });

  it("refuses ambiguous auto-detect when multiple active sessions exist", async () => {
    // Two active sessions; no env var; no explicit id → must refuse
    // rather than silently pick one. This is the structural fix for
    // the "wrong session got closed" failure mode.
    await stateInit({
      sessionId: "amb-one",
      branch: "feat/a",
      workflowType: "review",
      sessionDir: sessionDir("amb-one"),
      ocrDir,
    });
    await stateInit({
      sessionId: "amb-two",
      branch: "feat/b",
      workflowType: "review",
      sessionDir: sessionDir("amb-two"),
      ocrDir,
    });

    await expect(resolveActiveSession(ocrDir)).rejects.toThrow(
      /Ambiguous auto-detect/,
    );
  });

  it("disambiguates via OCR_DASHBOARD_EXECUTION_UID even with multiple active sessions", async () => {
    // Same setup as the ambiguity test, but with the env var pointing at
    // a command_executions row linked to the right session. The resolver
    // must follow that linkage instead of throwing.
    await stateInit({
      sessionId: "uid-right",
      branch: "feat/r",
      workflowType: "review",
      sessionDir: sessionDir("uid-right"),
      ocrDir,
    });
    await stateInit({
      sessionId: "uid-wrong",
      branch: "feat/w",
      workflowType: "review",
      sessionDir: sessionDir("uid-wrong"),
      ocrDir,
    });

    const { ensureDatabase: getDb } = await import("../../db/index.js");
    const db = await getDb(ocrDir);
    db.run(
      `INSERT INTO command_executions (uid, command, args, started_at, workflow_id)
       VALUES (?, 'review', '[]', datetime('now'), ?)`,
      ["dash-uid-disambig", "uid-right"],
    );

    const prev = process.env["OCR_DASHBOARD_EXECUTION_UID"];
    process.env["OCR_DASHBOARD_EXECUTION_UID"] = "dash-uid-disambig";
    try {
      const r = await resolveActiveSession(ocrDir);
      expect(r.id).toBe("uid-right");
      expect(r.decision).toBe("dashboard-uid");
    } finally {
      if (prev === undefined) delete process.env["OCR_DASHBOARD_EXECUTION_UID"];
      else process.env["OCR_DASHBOARD_EXECUTION_UID"] = prev;
    }
  });
});

describe("stateTransition — phase graph", () => {
  it("rejects illegal phase jumps (reviews → complete) on a review workflow", async () => {
    const dir = sessionDir("phase-jump-review");
    await stateInit({
      sessionId: "phase-jump-review",
      branch: "feat/pj",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });
    // Walk legal phases up to `reviews` first.
    for (const [phase, n] of [
      ["change-context", 2],
      ["analysis", 3],
      ["reviews", 4],
    ] as const) {
      await stateTransition({
        sessionId: "phase-jump-review",
        phase,
        phaseNumber: n,
        ocrDir,
      });
    }
    await expect(
      stateTransition({
        sessionId: "phase-jump-review",
        phase: "complete",
        phaseNumber: 8,
        ocrDir,
      }),
    ).rejects.toThrow(/Illegal phase transition: reviews → complete/);
  });

  it("rejects cross-workflow-type phases (topology on a review workflow)", async () => {
    const dir = sessionDir("cross-type");
    await stateInit({
      sessionId: "cross-type",
      branch: "feat/ct",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });
    await expect(
      stateTransition({
        sessionId: "cross-type",
        // "topology" is a valid map phase (so it type-checks across workflows)
        // but is rejected at runtime for a review session — the assertion below.
        phase: "topology",
        phaseNumber: 2,
        ocrDir,
      }),
    ).rejects.toThrow(/Invalid phase "topology" for workflow_type "review"/);
  });

  it("allows round-boundary transitions to reset to context", async () => {
    const dir = sessionDir("round-boundary");
    await stateInit({
      sessionId: "round-boundary",
      branch: "feat/rb",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });
    // Walk to complete legitimately.
    for (const [phase, n] of [
      ["change-context", 2],
      ["analysis", 3],
      ["reviews", 4],
      ["aggregation", 5],
      ["discourse", 6],
      ["synthesis", 7],
      ["complete", 8],
    ] as const) {
      await stateTransition({
        sessionId: "round-boundary",
        phase,
        phaseNumber: n,
        ocrDir,
      });
    }
    // Start round 2 by jumping back to context with explicit round bump.
    await expect(
      stateTransition({
        sessionId: "round-boundary",
        phase: "context",
        phaseNumber: 1,
        round: 2,
        ocrDir,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("stateClose — cascade + idempotency", () => {
  it("is idempotent on already-closed sessions", async () => {
    await beginReviewAtSynthesis("idemp");
    await stateCompleteRound({
      source: "stdin",
      ocrDir,
      sessionId: "idemp",
      data: JSON.stringify({ schema_version: 1, verdict: "APPROVE", reviewers: [] }),
    });
    await stateClose({ sessionId: "idemp", ocrDir });
    // Second close: must not throw, must not write a duplicate event.
    await expect(
      stateClose({ sessionId: "idemp", ocrDir }),
    ).resolves.toBeUndefined();

    const show = await stateShow(ocrDir, "idemp");
    const closeEvents =
      show?.events.filter((e) => e.event_type === "session_closed") ?? [];
    expect(closeEvents.length).toBe(1);
  });

  it("cascade-closes in-flight dependent command_executions", async () => {
    const dir = sessionDir("cascade");
    await stateInit({
      sessionId: "cascade",
      branch: "feat/c",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });

    const { ensureDatabase: getDb } = await import("../../db/index.js");
    const db = await getDb(ocrDir);
    db.run(
      `INSERT INTO command_executions (uid, command, args, started_at, workflow_id, last_heartbeat_at)
       VALUES (?, 'review', '[]', datetime('now'), ?, datetime('now'))`,
      ["dash-cascade-uid", "cascade"],
    );

    await stateClose({ sessionId: "cascade", ocrDir, abort: true });

    const result = db.exec(
      `SELECT exit_code, finished_at, notes
         FROM command_executions
        WHERE uid = ?`,
      ["dash-cascade-uid"],
    );
    const row = result[0]?.values[0];
    expect(row).toBeDefined();
    expect(row?.[0]).toBe(-4); // CASCADE_CLOSE_EXIT_CODE
    expect(row?.[1]).toBeTruthy(); // finished_at populated
    expect(String(row?.[2] ?? "")).toMatch(/closed by parent workflow close/);
  });
});

describe("stateInit — re-open derives round from events", () => {
  it("derives next round from MAX(round_completed.round) + 1, ignoring filesystem", async () => {
    // Setup: complete round 1 via stateCompleteRound, then re-init.
    const dir = await beginReviewAtSynthesis("round-from-events");
    const meta = makeRoundMeta({ verdict: "APPROVE", reviewers: [] });
    const filePath = writeRoundMeta(dir, meta);
    await stateCompleteRound({
      source: "file",
      ocrDir,
      filePath,
      sessionId: "round-from-events",
    });
    await stateClose({ sessionId: "round-from-events", ocrDir });

    // No filesystem round directories — only the round-meta.json we wrote
    // is in `dir`, not a `rounds/round-N/` layout. Filesystem inference
    // would say round 1. Event-based derivation says round 2.
    const sid = await stateInit({
      sessionId: "round-from-events",
      branch: "feat/rfe",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });
    expect(sid).toBe("round-from-events");
    const show = await stateShow(ocrDir, "round-from-events");
    expect(show?.session.current_round).toBe(2);
  });

  it("rejects re-open with mismatched workflow_type", async () => {
    const dir = sessionDir("type-mismatch");
    await stateInit({
      sessionId: "type-mismatch",
      branch: "feat/tm",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });
    await stateClose({ sessionId: "type-mismatch", ocrDir, abort: true });
    await expect(
      stateInit({
        sessionId: "type-mismatch",
        branch: "feat/tm",
        workflowType: "map",
        sessionDir: dir,
        ocrDir,
      }),
    ).rejects.toThrow(/Cannot re-open session/);
  });
});

// ── round-meta.json helpers ──

function writeRoundMeta(dir: string, meta: RoundMeta): string {
  const filePath = join(dir, "round-meta.json");
  writeFileSync(filePath, JSON.stringify(meta));
  return filePath;
}

function makeRoundMeta(overrides?: Partial<RoundMeta>): RoundMeta {
  return {
    schema_version: 1,
    verdict: "REQUEST CHANGES",
    reviewers: [
      {
        type: "principal",
        instance: 1,
        severity_high: 1,
        severity_medium: 2,
        severity_low: 1,
        severity_info: 0,
        findings: [
          {
            title: "SQL Injection",
            category: "blocker",
            severity: "high",
            file_path: "src/api/users.ts",
            line_start: 42,
            line_end: 45,
            summary: "User input passed directly to query",
            flagged_by: ["@principal-1"],
          },
          {
            title: "Missing validation",
            category: "should_fix",
            severity: "medium",
            file_path: "src/api/users.ts",
            line_start: 10,
            summary: "No input validation on email",
          },
          {
            title: "Consider caching",
            category: "suggestion",
            severity: "low",
            summary: "Repeated queries could benefit from caching",
          },
        ],
      },
      {
        type: "quality",
        instance: 1,
        findings: [
          {
            title: "Dead code",
            category: "should_fix",
            severity: "medium",
            file_path: "src/utils.ts",
            line_start: 100,
            line_end: 120,
            summary: "Unused helper function",
          },
          {
            title: "Rename variable",
            category: "style",
            severity: "info",
            summary: "Use descriptive name instead of x",
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("computeRoundCounts", () => {
  it("derives counts from findings array", () => {
    const meta = makeRoundMeta();
    const counts = computeRoundCounts(meta);

    expect(counts.blockerCount).toBe(1);
    expect(counts.shouldFixCount).toBe(2);
    expect(counts.suggestionCount).toBe(1);
    expect(counts.reviewerCount).toBe(2);
    expect(counts.totalFindingCount).toBe(5);
  });

  it("returns zeros for empty reviewers", () => {
    const meta = makeRoundMeta({ reviewers: [] });
    const counts = computeRoundCounts(meta);

    expect(counts.blockerCount).toBe(0);
    expect(counts.shouldFixCount).toBe(0);
    expect(counts.suggestionCount).toBe(0);
    expect(counts.reviewerCount).toBe(0);
    expect(counts.totalFindingCount).toBe(0);
  });

  it("does not count style findings as suggestions", () => {
    const meta = makeRoundMeta({
      reviewers: [
        {
          type: "quality",
          instance: 1,
          findings: [
            { title: "Style issue", category: "style", severity: "info", summary: "x" },
            { title: "Real suggestion", category: "suggestion", severity: "low", summary: "y" },
          ],
        },
      ],
    });
    const counts = computeRoundCounts(meta);

    expect(counts.suggestionCount).toBe(1);
    expect(counts.totalFindingCount).toBe(2);
  });

  it("prefers synthesis_counts over derived counts when present", () => {
    const meta = makeRoundMeta({
      synthesis_counts: { blockers: 0, should_fix: 3, suggestions: 5 },
    });
    const counts = computeRoundCounts(meta);

    // synthesis_counts override derived values
    expect(counts.blockerCount).toBe(0);
    expect(counts.shouldFixCount).toBe(3);
    expect(counts.suggestionCount).toBe(5);
    // reviewer/total counts are always derived
    expect(counts.reviewerCount).toBe(2);
    expect(counts.totalFindingCount).toBe(5);
  });

  it("falls back to derived counts when synthesis_counts is absent", () => {
    const meta = makeRoundMeta();
    expect(meta.synthesis_counts).toBeUndefined();
    const counts = computeRoundCounts(meta);

    // Should use derived counts (same as first test)
    expect(counts.blockerCount).toBe(1);
    expect(counts.shouldFixCount).toBe(2);
    expect(counts.suggestionCount).toBe(1);
  });
});

// ── round-meta schema validation (extracted pure validator) ──
//
// These were originally exercised through the now-deleted round-complete
// porcelain; the schema-guard behavior they pin lives in the pure
// `validateRoundMeta`. Re-targeting them there keeps coverage equivalent while
// dropping the irrelevant session/DB scaffolding.

describe("validateRoundMeta", () => {
  it("throws on invalid schema_version", () => {
    expect(() =>
      validateRoundMeta({ schema_version: 99, verdict: "APPROVE", reviewers: [] }),
    ).toThrow("Unsupported schema_version: 99");
  });

  it("throws on missing verdict", () => {
    expect(() =>
      validateRoundMeta({ schema_version: 1, reviewers: [] }),
    ).toThrow("must contain a verdict string");
  });

  it("throws on an off-vocabulary verdict (the accept_with_followups bug)", () => {
    expect(() =>
      validateRoundMeta({
        schema_version: 1,
        verdict: "accept_with_followups",
        reviewers: [],
      }),
    ).toThrow(/is not one of: APPROVE, REQUEST CHANGES, NEEDS DISCUSSION/);
  });

  it("accepts a canonical verdict modulo surrounding whitespace", () => {
    const meta = validateRoundMeta({
      schema_version: 1,
      verdict: "  APPROVE  ",
      reviewers: [],
    });
    expect(meta.verdict).toBe("APPROVE");
  });

  it("throws on a degenerate (too-short) finding title", () => {
    expect(() =>
      validateRoundMeta({
        schema_version: 1,
        verdict: "APPROVE",
        reviewers: [
          {
            type: "principal",
            instance: 1,
            findings: [
              { title: "s", category: "blocker", severity: "high", summary: "x" },
            ],
          },
        ],
      }),
    ).toThrow(/at least 8 characters/);
  });

  it("throws when reviewers is not an array", () => {
    expect(() =>
      validateRoundMeta({ schema_version: 1, verdict: "APPROVE" }),
    ).toThrow("reviewers array");
  });

  it("throws on invalid finding category", () => {
    expect(() =>
      validateRoundMeta({
        schema_version: 1,
        verdict: "APPROVE",
        reviewers: [
          {
            type: "principal",
            instance: 1,
            findings: [
              { title: "Bad category here", category: "critical_issue", severity: "high", summary: "x" },
            ],
          },
        ],
      }),
    ).toThrow("invalid category");
  });

  it("throws on invalid finding severity", () => {
    expect(() =>
      validateRoundMeta({
        schema_version: 1,
        verdict: "APPROVE",
        reviewers: [
          {
            type: "principal",
            instance: 1,
            findings: [
              { title: "Bad severity here", category: "blocker", severity: "nuclear", summary: "x" },
            ],
          },
        ],
      }),
    ).toThrow("invalid severity");
  });

  it("throws on a non-object finding shape", () => {
    expect(() =>
      validateRoundMeta({
        schema_version: 1,
        verdict: "APPROVE",
        reviewers: [{ type: "principal", instance: 1, findings: ["not an object"] }],
      }),
    ).toThrow("Each finding must be an object");
  });

  it("accepts a well-formed round-meta and returns it", () => {
    const meta = makeRoundMeta();
    expect(validateRoundMeta(meta)).toBe(meta);
  });

  it("throws when a synthesis_count exceeds its derived category tally (inflated)", () => {
    // makeRoundMeta has 1 blocker finding; claiming 2 is impossible (you cannot
    // dedup up to more than you started with) — the "wrong counts" symptom.
    expect(() =>
      validateRoundMeta(
        makeRoundMeta({ synthesis_counts: { blockers: 2, should_fix: 0, suggestions: 0 } }),
      ),
    ).toThrow(/synthesis_counts.blockers \(2\) exceeds the 1 blocker finding/);
  });

  it("allows a synthesis_count <= the derived tally (legitimate cross-reviewer dedup)", () => {
    // 2 should_fix findings present; a deduplicated count of 1 is legal.
    const meta = makeRoundMeta({
      synthesis_counts: { blockers: 1, should_fix: 1, suggestions: 1 },
    });
    expect(validateRoundMeta(meta)).toBe(meta);
  });

  // ── Directional verdict ↔ blocker-count contract ──

  it("rejects APPROVE when the blocker count is non-zero", () => {
    // makeRoundMeta() default has 1 blocker finding; APPROVE is inconsistent.
    expect(() =>
      validateRoundMeta(makeRoundMeta({ verdict: "APPROVE" })),
    ).toThrow(/verdict "APPROVE" is inconsistent with 1 blocker/);
  });

  it("rejects REQUEST CHANGES when the blocker count is zero", () => {
    // Only should_fix/suggestion findings → zero blockers → nothing to block on.
    expect(() =>
      validateRoundMeta({
        schema_version: 1,
        verdict: "REQUEST CHANGES",
        reviewers: [
          {
            type: "principal",
            instance: 1,
            findings: [
              { title: "Should fix this", category: "should_fix", severity: "medium", summary: "x" },
            ],
          },
        ],
      }),
    ).toThrow(/verdict "REQUEST CHANGES" requires at least one blocker finding; found 0/);
  });

  it("accepts APPROVE when blocker findings deduplicate to zero via synthesis_counts", () => {
    // Raw blocker tally is 1, but the deduplicated synthesis count is 0, so the
    // directional check uses 0 and APPROVE is consistent — no contradiction with
    // the "synthesis_count <= derived tally" rule.
    const meta = {
      schema_version: 1,
      verdict: "APPROVE",
      synthesis_counts: { blockers: 0, should_fix: 0, suggestions: 0 },
      reviewers: [
        {
          type: "principal",
          instance: 1,
          findings: [
            { title: "Dup blocker one", category: "blocker", severity: "high", summary: "x" },
          ],
        },
      ],
    };
    expect(validateRoundMeta(meta)).toBe(meta);
  });

  it("accepts REQUEST CHANGES with at least one blocker", () => {
    const meta = makeRoundMeta(); // default: REQUEST CHANGES + 1 blocker
    expect(validateRoundMeta(meta)).toBe(meta);
  });

  it("accepts NEEDS DISCUSSION regardless of blocker count", () => {
    const withBlocker = makeRoundMeta({ verdict: "NEEDS DISCUSSION" });
    expect(validateRoundMeta(withBlocker)).toBe(withBlocker);
    const withoutBlocker = {
      schema_version: 1,
      verdict: "NEEDS DISCUSSION",
      reviewers: [],
    };
    expect(validateRoundMeta(withoutBlocker)).toBe(withoutBlocker);
  });
});

describe("stateCompleteRound (atomic finalize)", () => {
  it("reads JSON, computes counts, and creates round_completed event", async () => {
    const dir = await beginReviewAtSynthesis("round-complete-test");

    const meta = makeRoundMeta();
    const filePath = writeRoundMeta(dir, meta);

    await stateCompleteRound({
      source: "file",
      ocrDir,
      filePath,
      sessionId: "round-complete-test",
    });

    const result = await stateShow(ocrDir, "round-complete-test");
    const events = result?.events ?? [];
    const rcEvent = events.find((e) => e.event_type === "round_completed");
    expect(rcEvent).toBeDefined();

    const metadata = JSON.parse(rcEvent!.metadata!);
    expect(metadata.verdict).toBe("REQUEST CHANGES");
    expect(metadata.blocker_count).toBe(1);
    expect(metadata.should_fix_count).toBe(2);
    expect(metadata.suggestion_count).toBe(1);
    expect(metadata.reviewer_count).toBe(2);
    expect(metadata.total_finding_count).toBe(5);
    expect(metadata.source).toBe("orchestrator");
  });

  it("auto-detects active session when no session ID given", async () => {
    const dir = await beginReviewAtSynthesis("auto-detect-rc");

    const meta = makeRoundMeta({ verdict: "APPROVE", reviewers: [] });
    const filePath = writeRoundMeta(dir, meta);

    await stateCompleteRound({ source: "file", ocrDir, filePath });

    const result = await stateShow(ocrDir, "auto-detect-rc");
    const rcEvent = result?.events.find((e) => e.event_type === "round_completed");
    expect(rcEvent).toBeDefined();
    const metadata = JSON.parse(rcEvent!.metadata!);
    expect(metadata.verdict).toBe("APPROVE");
  });

  it("rejects invalid metadata with SCHEMA_INVALID (atomic path wraps validator)", async () => {
    const dir = await beginReviewAtSynthesis("bad-schema");

    const filePath = join(dir, "round-meta.json");
    writeFileSync(filePath, JSON.stringify({ schema_version: 99, verdict: "APPROVE", reviewers: [] }));

    await expect(
      stateCompleteRound({ source: "file", ocrDir, filePath, sessionId: "bad-schema" }),
    ).rejects.toMatchObject({
      code: STATE_EXIT.SCHEMA_INVALID,
      message: expect.stringContaining("Unsupported schema_version: 99"),
    });
  });

  it("wraps a missing input file as SCHEMA_INVALID", async () => {
    const dir = await beginReviewAtSynthesis("missing-file");

    await expect(
      stateCompleteRound({
        source: "file",
        ocrDir,
        filePath: join(dir, "nonexistent.json"),
        sessionId: "missing-file",
      }),
    ).rejects.toMatchObject({
      code: STATE_EXIT.SCHEMA_INVALID,
      message: expect.stringContaining("File not found"),
    });
  });

  it("throws when no active session and no session-id given", async () => {
    // Ensure DB exists via init + close
    const dir = sessionDir("no-active-rc");
    await stateInit({
      sessionId: "no-active-rc",
      branch: "feat/na",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });
    await stateClose({ sessionId: "no-active-rc", ocrDir, abort: true });

    const meta = makeRoundMeta();
    const filePath = writeRoundMeta(dir, meta);

    await expect(
      stateCompleteRound({ source: "file", ocrDir, filePath }),
    ).rejects.toThrow("No active session found");
  });

  it("uses explicit session-id and round when provided", async () => {
    const dir = await beginReviewAtSynthesis("explicit-rc");

    const meta = makeRoundMeta({ verdict: "APPROVE", reviewers: [] });
    const filePath = writeRoundMeta(dir, meta);

    await stateCompleteRound({
      source: "file",
      ocrDir,
      filePath,
      sessionId: "explicit-rc",
      round: 3,
    });

    const result = await stateShow(ocrDir, "explicit-rc");
    const rcEvent = result?.events.find((e) => e.event_type === "round_completed");
    expect(rcEvent).toBeDefined();
    expect(rcEvent?.round).toBe(3);
  });

  it("prefers OCR_DASHBOARD_EXECUTION_UID linkage over latest-active fallback", async () => {
    // Reproduces the auto-detect ambiguity bug: with multiple active
    // sessions, the latest-active fallback would pick the wrong one.
    // The dashboard sets OCR_DASHBOARD_EXECUTION_UID for the AI it spawns,
    // and the capture service binds that uid -> command_executions.workflow_id.
    // complete-round must follow that linkage.

    // Older "right" session — what the dashboard actually spawned the AI for.
    // Walk it to synthesis so the atomic finalize's proof-of-work passes.
    const rightDir = await beginReviewAtSynthesis("right-session");

    // Newer "wrong" session — would win latest-active auto-detect because
    // its started_at is later. Simulates an unrelated session a user kicked
    // off in the same project shortly after.
    await new Promise((r) => setTimeout(r, 1100));
    await beginReviewAtSynthesis("wrong-session");

    // Seed a command_executions row linked to the right session, mirroring
    // what the SessionCaptureService produces when the dashboard binds.
    const { ensureDatabase: getDb } = await import("../../db/index.js");
    const db = await getDb(ocrDir);
    db.run(
      `INSERT INTO command_executions
         (uid, command, args, started_at, vendor, workflow_id)
       VALUES (?, 'review', '[]', datetime('now'), 'claude', ?)`,
      ["dash-uid-test", "right-session"],
    );

    const meta = makeRoundMeta({ verdict: "APPROVE", reviewers: [] });
    const filePath = writeRoundMeta(rightDir, meta);

    const prevEnv = process.env["OCR_DASHBOARD_EXECUTION_UID"];
    process.env["OCR_DASHBOARD_EXECUTION_UID"] = "dash-uid-test";
    try {
      const result = await stateCompleteRound({
        source: "file",
        ocrDir,
        filePath,
      });
      expect(result.sessionId).toBe("right-session");
    } finally {
      if (prevEnv === undefined) delete process.env["OCR_DASHBOARD_EXECUTION_UID"];
      else process.env["OCR_DASHBOARD_EXECUTION_UID"] = prevEnv;
    }

    // Wrong session must NOT have a round_completed event.
    const wrongShow = await stateShow(ocrDir, "wrong-session");
    expect(
      wrongShow?.events.find((e) => e.event_type === "round_completed"),
    ).toBeUndefined();
  });

  it("refuses to finalize a closed session (INVARIANT_UNMET — not at synthesis)", async () => {
    // The deleted round-complete porcelain let you write a round_completed
    // event against a closed session at any phase. The atomic
    // `stateCompleteRound` enforces proof-of-work: a closed session sits at
    // "complete", so the finalize must refuse rather than fabricate a completion.
    const dir = sessionDir("closed-target");
    await stateInit({
      sessionId: "closed-target",
      branch: "feat/ct",
      workflowType: "review",
      sessionDir: dir,
      ocrDir,
    });
    await stateClose({ sessionId: "closed-target", ocrDir, abort: true });

    const meta = makeRoundMeta({ verdict: "APPROVE", reviewers: [] });
    const filePath = writeRoundMeta(dir, meta);

    await expect(
      stateCompleteRound({
        source: "file",
        ocrDir,
        filePath,
        sessionId: "closed-target",
      }),
    ).rejects.toMatchObject({ code: STATE_EXIT.INVARIANT_UNMET });
  });
});

describe("stateCompleteRound — canonical verdict contract (exit 7)", () => {
  // The accept_with_followups bug: the orchestrator wrote an off-vocabulary
  // verdict that slipped past the old non-empty check and rendered as "?" in
  // the dashboard. complete-round must now fail-fast with SCHEMA_INVALID
  // (exit 7) so the orchestrator self-corrects and nothing is written.
  it("rejects an off-vocabulary verdict with SCHEMA_INVALID", async () => {
    await beginReviewAtSynthesis("verdict-offvocab");

    await expect(
      stateCompleteRound({
        source: "stdin",
        ocrDir,
        data: JSON.stringify({
          schema_version: 1,
          verdict: "accept_with_followups",
          reviewers: [],
        }),
        sessionId: "verdict-offvocab",
      }),
    ).rejects.toMatchObject({
      code: STATE_EXIT.SCHEMA_INVALID,
      message: expect.stringContaining("is not one of"),
    });

    // Nothing written: no round_completed event for the session.
    const state = await stateShow(ocrDir, "verdict-offvocab");
    expect(
      state?.events.find((e) => e.event_type === "round_completed"),
    ).toBeUndefined();
  });

  it("rejects a degenerate finding title with SCHEMA_INVALID", async () => {
    await beginReviewAtSynthesis("title-degenerate");

    await expect(
      stateCompleteRound({
        source: "stdin",
        ocrDir,
        data: JSON.stringify({
          schema_version: 1,
          verdict: "APPROVE",
          reviewers: [
            {
              type: "principal",
              instance: 1,
              findings: [
                { title: "s", category: "blocker", severity: "high", summary: "x" },
              ],
            },
          ],
        }),
        sessionId: "title-degenerate",
      }),
    ).rejects.toMatchObject({
      code: STATE_EXIT.SCHEMA_INVALID,
      message: expect.stringContaining("at least 8 characters"),
    });
  });

  it("rejects an inflated synthesis_count with SCHEMA_INVALID", async () => {
    await beginReviewAtSynthesis("count-inflated");

    await expect(
      stateCompleteRound({
        source: "stdin",
        ocrDir,
        // One blocker finding present, but synthesis claims two.
        data: JSON.stringify({
          schema_version: 1,
          verdict: "REQUEST CHANGES",
          synthesis_counts: { blockers: 2, should_fix: 0, suggestions: 0 },
          reviewers: [
            {
              type: "principal",
              instance: 1,
              findings: [
                { title: "Real blocker here", category: "blocker", severity: "high", summary: "x" },
              ],
            },
          ],
        }),
        sessionId: "count-inflated",
      }),
    ).rejects.toMatchObject({
      code: STATE_EXIT.SCHEMA_INVALID,
      message: expect.stringContaining("exceeds"),
    });
  });

  it("accepts a deduplicated (lower-than-derived) synthesis_count", async () => {
    await beginReviewAtSynthesis("count-dedup");

    // Two should_fix findings present (same issue from two reviewers); the
    // deduplicated synthesis count of 1 is legitimate and must complete.
    // Verdict is APPROVE: there are zero blockers, only residual should_fix work,
    // so the merge gate is open (REQUEST CHANGES would require a blocker).
    const result = await stateCompleteRound({
      source: "stdin",
      ocrDir,
      data: JSON.stringify({
        schema_version: 1,
        verdict: "APPROVE",
        synthesis_counts: { blockers: 0, should_fix: 1, suggestions: 0 },
        reviewers: [
          {
            type: "principal",
            instance: 1,
            findings: [
              { title: "Duplicated finding", category: "should_fix", severity: "medium", summary: "x" },
            ],
          },
          {
            type: "quality",
            instance: 1,
            findings: [
              { title: "Duplicated finding", category: "should_fix", severity: "medium", summary: "x" },
            ],
          },
        ],
      }),
      sessionId: "count-dedup",
    });

    expect(result.sessionId).toBe("count-dedup");
    const state = await stateShow(ocrDir, "count-dedup");
    const rcEvent = state?.events.find((e) => e.event_type === "round_completed");
    expect(rcEvent).toBeDefined();
    // synthesis_counts is preferred over the derived (2) tally.
    expect(JSON.parse(rcEvent!.metadata!).should_fix_count).toBe(1);
  });

  it("completes a round on the canonical happy path", async () => {
    await beginReviewAtSynthesis("verdict-happy");

    const result = await stateCompleteRound({
      source: "stdin",
      ocrDir,
      data: JSON.stringify({
        schema_version: 1,
        verdict: "NEEDS DISCUSSION",
        reviewers: [],
      }),
      sessionId: "verdict-happy",
    });

    expect(result.sessionId).toBe("verdict-happy");
    const state = await stateShow(ocrDir, "verdict-happy");
    const rcEvent = state?.events.find((e) => e.event_type === "round_completed");
    expect(rcEvent).toBeDefined();
    expect(JSON.parse(rcEvent!.metadata!).verdict).toBe("NEEDS DISCUSSION");
  });
});

describe("stateCompleteRound with stdin", () => {
  it("accepts raw JSON data and creates round_completed event", async () => {
    await beginReviewAtSynthesis("stdin-basic");

    const meta = makeRoundMeta();
    const result = await stateCompleteRound({
      source: "stdin",
      ocrDir,
      data: JSON.stringify(meta),
      sessionId: "stdin-basic",
    });

    expect(result.sessionId).toBe("stdin-basic");
    expect(result.round).toBe(1);

    const state = await stateShow(ocrDir, "stdin-basic");
    const rcEvent = state?.events.find((e) => e.event_type === "round_completed");
    expect(rcEvent).toBeDefined();
    const metadata = JSON.parse(rcEvent!.metadata!);
    expect(metadata.blocker_count).toBe(1);
    expect(metadata.should_fix_count).toBe(2);
    expect(metadata.suggestion_count).toBe(1);
    expect(metadata.source).toBe("orchestrator");
  });

  it("writes round-meta.json to the correct session round directory", async () => {
    const dir = await beginReviewAtSynthesis("stdin-write");

    const meta = makeRoundMeta();
    const result = await stateCompleteRound({
      source: "stdin",
      ocrDir,
      data: JSON.stringify(meta),
      sessionId: "stdin-write",
    });

    const expectedPath = join(dir, "rounds", "round-1", "round-meta.json");
    expect(result.metaPath).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    const written = JSON.parse(readFileSync(expectedPath, "utf-8"));
    expect(written.schema_version).toBe(1);
    expect(written.verdict).toBe("REQUEST CHANGES");
  });

  it("creates rounds directory if it does not exist", async () => {
    const dir = await beginReviewAtSynthesis("stdin-mkdir");

    expect(existsSync(join(dir, "rounds"))).toBe(false);

    const meta = makeRoundMeta({ verdict: "APPROVE", reviewers: [] });
    const result = await stateCompleteRound({
      source: "stdin",
      ocrDir,
      data: JSON.stringify(meta),
      sessionId: "stdin-mkdir",
    });

    expect(existsSync(result.metaPath!)).toBe(true);
  });

  it("uses explicit session-id and round for file path", async () => {
    const dir = await beginReviewAtSynthesis("stdin-explicit");

    const meta = makeRoundMeta({ verdict: "APPROVE", reviewers: [] });
    const result = await stateCompleteRound({
      source: "stdin",
      ocrDir,
      data: JSON.stringify(meta),
      sessionId: "stdin-explicit",
      round: 3,
    });

    expect(result.round).toBe(3);
    const expectedPath = join(dir, "rounds", "round-3", "round-meta.json");
    expect(result.metaPath).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
  });

  it("throws SCHEMA_INVALID on invalid JSON from stdin", async () => {
    await beginReviewAtSynthesis("stdin-bad-json");

    await expect(
      stateCompleteRound({
        source: "stdin",
        ocrDir,
        data: "{ invalid json }",
        sessionId: "stdin-bad-json",
      }),
    ).rejects.toMatchObject({
      code: STATE_EXIT.SCHEMA_INVALID,
      message: expect.stringContaining("Failed to parse stdin"),
    });
  });

  it("throws SCHEMA_INVALID on invalid schema from stdin", async () => {
    await beginReviewAtSynthesis("stdin-bad-schema");

    await expect(
      stateCompleteRound({
        source: "stdin",
        ocrDir,
        data: JSON.stringify({ schema_version: 99, verdict: "x", reviewers: [] }),
        sessionId: "stdin-bad-schema",
      }),
    ).rejects.toMatchObject({
      code: STATE_EXIT.SCHEMA_INVALID,
      message: expect.stringContaining("Unsupported schema_version: 99"),
    });
  });

  it("file mode materializes round-meta.json at the canonical round path (D2)", async () => {
    // The artifact is the post-condition of a successful complete-round on BOTH
    // sources. A --file payload staged outside the round dir is copied to the
    // canonical path so the DB never reports `complete` without an on-disk artifact.
    const dir = await beginReviewAtSynthesis("file-materializes");

    const meta = makeRoundMeta();
    // Stage the payload OUTSIDE the canonical round dir (session root).
    const filePath = writeRoundMeta(dir, meta);
    const canonicalPath = join(dir, "rounds", "round-1", "round-meta.json");
    expect(existsSync(canonicalPath)).toBe(false);

    const result = await stateCompleteRound({
      source: "file",
      ocrDir,
      filePath,
      sessionId: "file-materializes",
    });

    expect(result.metaPath).toBe(canonicalPath);
    expect(existsSync(canonicalPath)).toBe(true);
    const written = JSON.parse(readFileSync(canonicalPath, "utf-8"));
    expect(written.schema_version).toBe(1);
    expect(written.verdict).toBe("REQUEST CHANGES");
  });

  it("re-running with the artifact present is a safe no-op (D2)", async () => {
    const dir = await beginReviewAtSynthesis("file-rerun-noop");
    const meta = makeRoundMeta();
    const filePath = writeRoundMeta(dir, meta);

    await stateCompleteRound({ source: "file", ocrDir, filePath, sessionId: "file-rerun-noop" });

    const before = await stateShow(ocrDir, "file-rerun-noop");
    const rcBefore = before!.events.filter((e) => e.event_type === "round_completed").length;
    const phaseBefore = before!.session.current_phase;
    const roundBefore = before!.session.current_round;

    // Re-run: artifact already present → no duplicate event, no re-advance.
    const result = await stateCompleteRound({
      source: "file",
      ocrDir,
      filePath,
      sessionId: "file-rerun-noop",
    });
    expect(result.metaPath).toBe(join(dir, "rounds", "round-1", "round-meta.json"));

    const after = await stateShow(ocrDir, "file-rerun-noop");
    expect(after!.events.filter((e) => e.event_type === "round_completed").length).toBe(rcBefore);
    expect(after!.session.current_phase).toBe(phaseBefore);
    expect(after!.session.current_round).toBe(roundBefore);
  });

  it("re-running with the artifact missing self-heals it without duplicating the event (D2)", async () => {
    const dir = await beginReviewAtSynthesis("file-self-heal");
    const meta = makeRoundMeta();
    const filePath = writeRoundMeta(dir, meta);

    await stateCompleteRound({ source: "file", ocrDir, filePath, sessionId: "file-self-heal" });
    const canonicalPath = join(dir, "rounds", "round-1", "round-meta.json");
    expect(existsSync(canonicalPath)).toBe(true);

    // Simulate a lost artifact (e.g. crash between commit and write, or deletion).
    rmSync(canonicalPath);
    expect(existsSync(canonicalPath)).toBe(false);

    const before = await stateShow(ocrDir, "file-self-heal");
    const rcBefore = before!.events.filter((e) => e.event_type === "round_completed").length;
    const roundBefore = before!.session.current_round;

    const result = await stateCompleteRound({
      source: "file",
      ocrDir,
      filePath,
      sessionId: "file-self-heal",
    });

    // Re-materialized, no duplicate event, no re-advance.
    expect(existsSync(canonicalPath)).toBe(true);
    expect(result.metaPath).toBe(canonicalPath);
    const after = await stateShow(ocrDir, "file-self-heal");
    expect(after!.events.filter((e) => e.event_type === "round_completed").length).toBe(rcBefore);
    expect(after!.session.current_round).toBe(roundBefore);
  });

  it("never commits the round_completed event while the artifact is absent (D2)", async () => {
    // The artifact write precedes the DB transaction, so a session reported
    // `complete` always has its on-disk artifact.
    const dir = await beginReviewAtSynthesis("file-invariant");
    const meta = makeRoundMeta();
    const filePath = writeRoundMeta(dir, meta);

    await stateCompleteRound({ source: "file", ocrDir, filePath, sessionId: "file-invariant" });

    const state = await stateShow(ocrDir, "file-invariant");
    const hasEvent = state!.events.some((e) => e.event_type === "round_completed");
    const canonicalPath = join(dir, "rounds", "round-1", "round-meta.json");
    expect(hasEvent).toBe(true);
    expect(existsSync(canonicalPath)).toBe(true);
  });
});

// ── map-meta.json helpers ──

function writeMapMeta(dir: string, meta: MapMeta): string {
  const filePath = join(dir, "map-meta.json");
  writeFileSync(filePath, JSON.stringify(meta));
  return filePath;
}

function makeMapMeta(overrides?: Partial<MapMeta>): MapMeta {
  return {
    schema_version: 1,
    sections: [
      {
        section_number: 1,
        title: "Core Logic",
        description: "Main business logic files",
        files: [
          { file_path: "src/index.ts", role: "Entry point", lines_added: 10, lines_deleted: 2 },
          { file_path: "src/lib/utils.ts", role: "Utility functions", lines_added: 5, lines_deleted: 0 },
        ],
      },
      {
        section_number: 2,
        title: "Tests",
        description: "Test files",
        files: [
          { file_path: "src/__tests__/index.test.ts", role: "Unit tests", lines_added: 20, lines_deleted: 0 },
        ],
      },
    ],
    dependencies: [
      {
        from_section: 2,
        from_title: "Tests",
        to_section: 1,
        to_title: "Core Logic",
        relationship: "tests",
      },
    ],
    ...overrides,
  };
}

describe("computeMapCounts", () => {
  it("derives counts from sections array", () => {
    const meta = makeMapMeta();
    const counts = computeMapCounts(meta);

    expect(counts.sectionCount).toBe(2);
    expect(counts.fileCount).toBe(3);
  });

  it("returns zeros for empty sections", () => {
    const meta = makeMapMeta({ sections: [] });
    const counts = computeMapCounts(meta);

    expect(counts.sectionCount).toBe(0);
    expect(counts.fileCount).toBe(0);
  });
});

// ── map-meta schema validation (extracted pure validator) ──
//
// Re-targeted from the deleted map-complete porcelain to the pure
// `validateMapMeta`, keeping the schema-guard coverage without the DB scaffold.

describe("validateMapMeta", () => {
  it("rejects invalid schema_version", () => {
    const bad = { ...makeMapMeta(), schema_version: 99 };
    expect(() => validateMapMeta(bad)).toThrow("Unsupported schema_version");
  });

  it("rejects missing sections array", () => {
    expect(() => validateMapMeta({ schema_version: 1 })).toThrow("sections array");
  });

  it("rejects a section missing its files array", () => {
    expect(() =>
      validateMapMeta({
        schema_version: 1,
        sections: [{ section_number: 1, title: "Core", description: "x" }],
      }),
    ).toThrow("files array");
  });

  it("rejects a file missing its file_path", () => {
    expect(() =>
      validateMapMeta({
        schema_version: 1,
        sections: [
          {
            section_number: 1,
            title: "Core",
            files: [{ role: "Entry point", lines_added: 1, lines_deleted: 0 }],
          },
        ],
      }),
    ).toThrow("non-empty file_path");
  });

  it("accepts a well-formed map-meta and returns it", () => {
    const meta = makeMapMeta();
    expect(validateMapMeta(meta)).toBe(meta);
  });
});

describe("stateCompleteMap (atomic finalize)", () => {
  it("creates a map_completed event from file", async () => {
    const dir = await beginMapAtSynthesis("map-complete-file");

    const meta = makeMapMeta();
    const filePath = writeMapMeta(dir, meta);

    const result = await stateCompleteMap({
      source: "file",
      ocrDir,
      filePath,
      sessionId: "map-complete-file",
    });

    expect(result.sessionId).toBe("map-complete-file");
    expect(result.mapRun).toBe(1);

    const state = await stateShow(ocrDir, "map-complete-file");
    const mapEvent = state!.events.find((e) => e.event_type === "map_completed");
    expect(mapEvent).toBeDefined();
    expect(mapEvent!.round).toBe(1); // round column stores map run number

    const metadata = JSON.parse(mapEvent!.metadata!);
    expect(metadata.section_count).toBe(2);
    expect(metadata.file_count).toBe(3);
    expect(metadata.source).toBe("orchestrator");
  });

  it("auto-detects active session and map run", async () => {
    const dir = await beginMapAtSynthesis("map-auto");

    const meta = makeMapMeta();
    const filePath = writeMapMeta(dir, meta);

    const result = await stateCompleteMap({
      source: "file",
      ocrDir,
      filePath,
    });

    expect(result.sessionId).toBe("map-auto");
    expect(result.mapRun).toBe(1);
  });

  it("wraps invalid schema_version as SCHEMA_INVALID", async () => {
    const dir = await beginMapAtSynthesis("map-bad-schema");

    const bad = { ...makeMapMeta(), schema_version: 99 };
    const filePath = writeMapMeta(dir, bad as MapMeta);

    await expect(
      stateCompleteMap({ source: "file", ocrDir, filePath, sessionId: "map-bad-schema" }),
    ).rejects.toMatchObject({
      code: STATE_EXIT.SCHEMA_INVALID,
      message: expect.stringContaining("Unsupported schema_version"),
    });
  });

  it("refuses to finalize when not at synthesis (INVARIANT_UNMET)", async () => {
    // The deleted map-complete porcelain wrote a map_completed event from any
    // phase. The atomic finalize enforces proof-of-work: a freshly begun map
    // session sits at "map-context", so the finalize must refuse.
    const dir = sessionDir("map-not-synth");
    await stateBegin({
      sessionId: "map-not-synth",
      branch: "feat/mns",
      workflowType: "map",
      sessionDir: dir,
      ocrDir,
    });

    const meta = makeMapMeta();
    const filePath = writeMapMeta(dir, meta);

    await expect(
      stateCompleteMap({ source: "file", ocrDir, filePath, sessionId: "map-not-synth" }),
    ).rejects.toMatchObject({ code: STATE_EXIT.INVARIANT_UNMET });
  });
});

describe("stateCompleteMap with stdin", () => {
  it("accepts data string and creates event", async () => {
    await beginMapAtSynthesis("map-stdin");

    const meta = makeMapMeta();
    const result = await stateCompleteMap({
      source: "stdin",
      ocrDir,
      data: JSON.stringify(meta),
      sessionId: "map-stdin",
    });

    expect(result.sessionId).toBe("map-stdin");
    expect(result.mapRun).toBe(1);

    const state = await stateShow(ocrDir, "map-stdin");
    const mapEvent = state!.events.find((e) => e.event_type === "map_completed");
    expect(mapEvent).toBeDefined();
  });

  it("writes map-meta.json to correct session path", async () => {
    const dir = await beginMapAtSynthesis("map-stdin-write");

    const meta = makeMapMeta();
    const result = await stateCompleteMap({
      source: "stdin",
      ocrDir,
      data: JSON.stringify(meta),
      sessionId: "map-stdin-write",
    });

    expect(result.metaPath).toBeDefined();
    const expectedPath = join(dir, "map", "runs", "run-1", "map-meta.json");
    expect(result.metaPath).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    const written = JSON.parse(readFileSync(expectedPath, "utf-8"));
    expect(written.schema_version).toBe(1);
    expect(written.sections).toHaveLength(2);
  });

  it("creates run directory if missing", async () => {
    const dir = await beginMapAtSynthesis("map-stdin-mkdir");

    const runDir = join(dir, "map", "runs", "run-1");
    expect(existsSync(runDir)).toBe(false);

    const meta = makeMapMeta();
    await stateCompleteMap({
      source: "stdin",
      ocrDir,
      data: JSON.stringify(meta),
      sessionId: "map-stdin-mkdir",
    });

    expect(existsSync(runDir)).toBe(true);
  });

  it("throws SCHEMA_INVALID on invalid JSON from stdin", async () => {
    await beginMapAtSynthesis("map-stdin-bad-json");

    await expect(
      stateCompleteMap({
        source: "stdin",
        ocrDir,
        data: "not json",
        sessionId: "map-stdin-bad-json",
      }),
    ).rejects.toMatchObject({
      code: STATE_EXIT.SCHEMA_INVALID,
      message: expect.stringContaining("Failed to parse stdin"),
    });
  });

  it("file mode materializes map-meta.json at the canonical run path (D2)", async () => {
    const dir = await beginMapAtSynthesis("map-file-materializes");

    const meta = makeMapMeta();
    // Stage the payload OUTSIDE the canonical run dir (session root).
    const filePath = writeMapMeta(dir, meta);
    const canonicalPath = join(dir, "map", "runs", "run-1", "map-meta.json");
    expect(existsSync(canonicalPath)).toBe(false);

    const result = await stateCompleteMap({
      source: "file",
      ocrDir,
      filePath,
      sessionId: "map-file-materializes",
    });

    expect(result.metaPath).toBe(canonicalPath);
    expect(existsSync(canonicalPath)).toBe(true);
    const written = JSON.parse(readFileSync(canonicalPath, "utf-8"));
    expect(written.schema_version).toBe(1);
    expect(written.sections).toHaveLength(2);
  });

  it("re-running with the artifact missing self-heals it without duplicating the event (D2)", async () => {
    const dir = await beginMapAtSynthesis("map-self-heal");
    const meta = makeMapMeta();
    const filePath = writeMapMeta(dir, meta);

    await stateCompleteMap({ source: "file", ocrDir, filePath, sessionId: "map-self-heal" });
    const canonicalPath = join(dir, "map", "runs", "run-1", "map-meta.json");
    rmSync(canonicalPath);
    expect(existsSync(canonicalPath)).toBe(false);

    const before = await stateShow(ocrDir, "map-self-heal");
    const mcBefore = before!.events.filter((e) => e.event_type === "map_completed").length;

    const result = await stateCompleteMap({
      source: "file",
      ocrDir,
      filePath,
      sessionId: "map-self-heal",
    });

    expect(existsSync(canonicalPath)).toBe(true);
    expect(result.metaPath).toBe(canonicalPath);
    const after = await stateShow(ocrDir, "map-self-heal");
    expect(after!.events.filter((e) => e.event_type === "map_completed").length).toBe(mcBefore);
  });
});
