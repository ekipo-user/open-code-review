import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTempWorkspace, removeTempWorkspace } from "../../db/test-support.js";
import { openDatabase, getSession, insertAgentSession, getEventsForSession } from "../../db/index.js";
import {
  stateBegin,
  stateAdvance,
  stateStatus,
  rebuildSessionProjection,
  tryAcquireForwardResumeLease,
  deriveStrandedStatus,
  closeForwardResumeExhausted,
  countForwardResumeLeases,
  remainingPhasesAfter,
  type StrandedConfig,
} from "../index.js";

let tmpDir: string;
let ocrDir: string;

beforeEach(() => {
  tmpDir = makeTempWorkspace("ocr-forward-resume-test-");
  ocrDir = join(tmpDir, ".ocr");
});

afterEach(() => {
  removeTempWorkspace(tmpDir);
});

async function dbHandle() {
  return await openDatabase(join(ocrDir, "data", "ocr.db"));
}

/** Begin a review and advance it to `reviews` — the #146 stranded shape:
 *  active, mid-pipeline, no round_completed, no live agent-session. */
async function beginStrandedAtReviews(sessionId: string): Promise<void> {
  await stateBegin({
    sessionId,
    branch: "feat/x",
    workflowType: "review",
    sessionDir: join(ocrDir, "sessions", sessionId),
    ocrDir,
  });
  for (const phase of ["change-context", "analysis", "reviews"]) {
    await stateAdvance({ sessionId, phase, ocrDir });
  }
}

const CFG: StrandedConfig = {
  maxAttempts: 2,
  heartbeatMs: 60_000,
  nowMs: 1_000_000_000_000, // fixed "now" far ahead of event timestamps
};

describe("remainingPhasesAfter", () => {
  it("lists review phases after the current phase through complete", () => {
    expect(remainingPhasesAfter("review", "reviews")).toEqual([
      "aggregation",
      "discourse",
      "synthesis",
      "complete",
    ]);
  });

  it("returns empty for the terminal phase", () => {
    expect(remainingPhasesAfter("review", "complete")).toEqual([]);
  });

  it("uses the map graph for map workflows", () => {
    expect(remainingPhasesAfter("map", "topology")).toEqual([
      "flow-analysis",
      "requirements-mapping",
      "synthesis",
      "complete",
    ]);
  });
});

describe("deriveStrandedStatus", () => {
  it("classifies a dead, incomplete mid-pipeline run as forward_resume", async () => {
    await beginStrandedAtReviews("strand-1");
    const db = await dbHandle();
    const session = getSession(db, "strand-1")!;
    const s = deriveStrandedStatus(db, session, CFG);
    expect(s).not.toBeNull();
    expect(s!.action).toBe("forward_resume");
    expect(s!.remainingPhases).toEqual([
      "aggregation",
      "discourse",
      "synthesis",
      "complete",
    ]);
    expect(s!.attemptsRemaining).toBe(2);
  });

  it("returns null (not stranded) when a live owning turn exists", async () => {
    await beginStrandedAtReviews("strand-live");
    const db = await dbHandle();
    insertAgentSession(db, {
      id: "inst-1",
      workflow_id: "strand-live",
      vendor: "claude",
    });
    const session = getSession(db, "strand-live")!;
    // nowMs close to the just-written heartbeat → fresh → live.
    const s = deriveStrandedStatus(db, session, { maxAttempts: 2, heartbeatMs: 60_000, nowMs: Date.now() });
    expect(s).toBeNull();
  });

  it("classifies as abort_or_fresh once the cap is exhausted", async () => {
    await beginStrandedAtReviews("strand-cap");
    const db = await dbHandle();
    const session = getSession(db, "strand-cap")!;
    const base = Date.now();
    // Acquire up to the cap (2), each time after the prior lease's TTL lapses.
    tryAcquireForwardResumeLease(db, "strand-cap", session.current_round, { leaseMs: 1000, maxAttempts: 2, nowMs: base });
    tryAcquireForwardResumeLease(db, "strand-cap", session.current_round, { leaseMs: 1000, maxAttempts: 2, nowMs: base + 5000 });
    // cap check is by lease COUNT (2), independent of lease liveness.
    const s = deriveStrandedStatus(db, session, { maxAttempts: 2, heartbeatMs: 60_000, nowMs: base + 9000 });
    expect(s!.action).toBe("abort_or_fresh");
    expect(s!.attemptsRemaining).toBe(0);
  });
});

describe("tryAcquireForwardResumeLease", () => {
  it("admits a single writer; a concurrent attempt with a live lease is refused", async () => {
    await beginStrandedAtReviews("lease-1");
    const db = await dbHandle();
    const round = getSession(db, "lease-1")!.current_round;
    const base = Date.now();
    const a = tryAcquireForwardResumeLease(db, "lease-1", round, { leaseMs: 60_000, maxAttempts: 2, nowMs: base });
    const b = tryAcquireForwardResumeLease(db, "lease-1", round, { leaseMs: 60_000, maxAttempts: 2, nowMs: base + 500 });
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(false);
    expect(b.acquired === false && b.reason).toBe("lease_held");
    // Only one lease recorded.
    expect(countForwardResumeLeases(getEventsForSession(db, "lease-1"), round)).toBe(1);
  });

  it("counts the attempt even if the prior continuation died before doing work", async () => {
    await beginStrandedAtReviews("lease-die");
    const db = await dbHandle();
    const round = getSession(db, "lease-die")!.current_round;
    const base = Date.now();
    // First lease; it "dies" (no phase_transition). Its TTL lapses.
    const a = tryAcquireForwardResumeLease(db, "lease-die", round, { leaseMs: 1000, maxAttempts: 2, nowMs: base });
    // Second attempt after TTL: lease not held, but the cap counter still saw the first.
    const b = tryAcquireForwardResumeLease(db, "lease-die", round, { leaseMs: 1000, maxAttempts: 2, nowMs: base + 5000 });
    // Third attempt: cap (2) now exhausted.
    const c = tryAcquireForwardResumeLease(db, "lease-die", round, { leaseMs: 1000, maxAttempts: 2, nowMs: base + 9000 });
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
    expect(c.acquired).toBe(false);
    expect(c.acquired === false && c.reason).toBe("cap_exhausted");
  });

  it("does not regress current_phase (lease carries no phase column)", async () => {
    await beginStrandedAtReviews("lease-noregress");
    const db = await dbHandle();
    const round = getSession(db, "lease-noregress")!.current_round;
    tryAcquireForwardResumeLease(db, "lease-noregress", round, { leaseMs: 60_000, maxAttempts: 2, nowMs: Date.now() });
    const projected = rebuildSessionProjection(db, "lease-noregress")!;
    expect(projected.current_phase).toBe("reviews");
    expect(projected.status).toBe("active");
  });
});

describe("closeForwardResumeExhausted", () => {
  it("closes the session non-success via session_auto_closed_stale, preserving artifacts", async () => {
    await beginStrandedAtReviews("exhaust-close");
    const db = await dbHandle();
    closeForwardResumeExhausted(db, "exhaust-close", 2);
    const session = getSession(db, "exhaust-close")!;
    expect(session.status).toBe("closed");
    const events = getEventsForSession(db, "exhaust-close");
    const close = events.find((e) => e.event_type === "session_auto_closed_stale");
    expect(close).toBeDefined();
    expect(JSON.parse(close!.metadata!).reason).toBe("forward_resume_exhausted");
    // Never a success close.
    expect(events.find((e) => e.event_type === "session_closed")).toBeUndefined();
    expect(events.find((e) => e.event_type === "session_aborted")).toBeUndefined();
  });
});

describe("stateStatus — forward-resume integration", () => {
  it("reports forward_resume with current_phase and remaining phases for a stranded run", async () => {
    await beginStrandedAtReviews("status-strand");
    const status = await stateStatus(ocrDir, "status-strand", CFG);
    expect(status.next_action_kind).toBe("forward_resume");
    expect(status.current_phase).toBe("reviews");
    expect(status.remaining_phases).toEqual([
      "aggregation",
      "discourse",
      "synthesis",
      "complete",
    ]);
    expect(status.forward_resume_attempts_remaining).toBe(2);
  });

  it("keeps the legacy 'advance' classification when no forward-resume config is supplied", async () => {
    await beginStrandedAtReviews("status-legacy");
    const status = await stateStatus(ocrDir, "status-legacy");
    expect(status.next_action_kind).toBe("advance");
    expect(status.remaining_phases).toBeUndefined();
  });
});

describe("stateBegin — refuses re-opening an active incomplete session", () => {
  it("throws rather than resetting a stranded run to context", async () => {
    await beginStrandedAtReviews("begin-refuse");
    await expect(
      stateBegin({
        sessionId: "begin-refuse",
        branch: "feat/x",
        workflowType: "review",
        sessionDir: join(ocrDir, "sessions", "begin-refuse"),
        ocrDir,
      }),
    ).rejects.toThrow(/active and its current round is not complete/);
    // The run is untouched: still at reviews.
    expect(getSession(await dbHandle(), "begin-refuse")!.current_phase).toBe("reviews");
  });
});
