import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_AGENT_HEARTBEAT_SECONDS,
  DEFAULT_WORKFLOW_HARD_DEADLINE_MINUTES,
  DEFAULT_FORWARD_RESUME_MAX_ATTEMPTS,
  DEFAULT_FORWARD_RESUME_LEASE_SECONDS,
  getAgentHeartbeatSeconds,
  getWorkflowHardDeadlineMs,
  getForwardResumeMaxAttempts,
  getForwardResumeLeaseMs,
} from "../runtime-config.js";

let tmpDir: string;
let ocrDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ocr-runtime-config-test-"));
  ocrDir = join(tmpDir, ".ocr");
  mkdirSync(ocrDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getAgentHeartbeatSeconds", () => {
  it("returns the default when config.yaml does not exist", () => {
    expect(getAgentHeartbeatSeconds(ocrDir)).toBe(
      DEFAULT_AGENT_HEARTBEAT_SECONDS,
    );
  });

  it("returns the default when runtime block is absent", () => {
    writeFileSync(
      join(ocrDir, "config.yaml"),
      `default_team:\n  principal: 2\n`,
    );
    expect(getAgentHeartbeatSeconds(ocrDir)).toBe(
      DEFAULT_AGENT_HEARTBEAT_SECONDS,
    );
  });

  it("reads block-form runtime.agent_heartbeat_seconds", () => {
    writeFileSync(
      join(ocrDir, "config.yaml"),
      `runtime:\n  agent_heartbeat_seconds: 120\n`,
    );
    expect(getAgentHeartbeatSeconds(ocrDir)).toBe(120);
  });

  it("reads inline runtime block", () => {
    writeFileSync(
      join(ocrDir, "config.yaml"),
      `runtime: { agent_heartbeat_seconds: 90 }\n`,
    );
    expect(getAgentHeartbeatSeconds(ocrDir)).toBe(90);
  });

  it("falls back to default for non-numeric values", () => {
    writeFileSync(
      join(ocrDir, "config.yaml"),
      `runtime:\n  agent_heartbeat_seconds: "not-a-number"\n`,
    );
    expect(getAgentHeartbeatSeconds(ocrDir)).toBe(
      DEFAULT_AGENT_HEARTBEAT_SECONDS,
    );
  });

  it("falls back to default for non-positive values", () => {
    writeFileSync(
      join(ocrDir, "config.yaml"),
      `runtime:\n  agent_heartbeat_seconds: 0\n`,
    );
    expect(getAgentHeartbeatSeconds(ocrDir)).toBe(
      DEFAULT_AGENT_HEARTBEAT_SECONDS,
    );
  });

  it("falls back to default for non-integer values", () => {
    writeFileSync(
      join(ocrDir, "config.yaml"),
      `runtime:\n  agent_heartbeat_seconds: 60.5\n`,
    );
    expect(getAgentHeartbeatSeconds(ocrDir)).toBe(
      DEFAULT_AGENT_HEARTBEAT_SECONDS,
    );
  });

  it("ignores trailing comments", () => {
    writeFileSync(
      join(ocrDir, "config.yaml"),
      `runtime:\n  agent_heartbeat_seconds: 45 # configured for slow models\n`,
    );
    expect(getAgentHeartbeatSeconds(ocrDir)).toBe(45);
  });
});

describe("getWorkflowHardDeadlineMs", () => {
  it("returns the default (in ms) when config.yaml does not exist", () => {
    expect(getWorkflowHardDeadlineMs(ocrDir)).toBe(
      DEFAULT_WORKFLOW_HARD_DEADLINE_MINUTES * 60 * 1000,
    );
  });

  it("reads runtime.workflow_hard_deadline_minutes and converts to ms", () => {
    writeFileSync(
      join(ocrDir, "config.yaml"),
      `runtime:\n  workflow_hard_deadline_minutes: 180\n`,
    );
    expect(getWorkflowHardDeadlineMs(ocrDir)).toBe(180 * 60 * 1000);
  });

  it("falls back to the default for a non-positive value", () => {
    writeFileSync(
      join(ocrDir, "config.yaml"),
      `runtime:\n  workflow_hard_deadline_minutes: 0\n`,
    );
    expect(getWorkflowHardDeadlineMs(ocrDir)).toBe(
      DEFAULT_WORKFLOW_HARD_DEADLINE_MINUTES * 60 * 1000,
    );
  });
});

describe("getForwardResumeMaxAttempts", () => {
  it("returns the default when config.yaml does not exist", () => {
    expect(getForwardResumeMaxAttempts(ocrDir)).toBe(
      DEFAULT_FORWARD_RESUME_MAX_ATTEMPTS,
    );
  });

  it("reads runtime.forward_resume_max_attempts", () => {
    writeFileSync(
      join(ocrDir, "config.yaml"),
      `runtime:\n  forward_resume_max_attempts: 3\n`,
    );
    expect(getForwardResumeMaxAttempts(ocrDir)).toBe(3);
  });

  it("falls back to the safe default for a value < 1 (never a coerced 0)", () => {
    writeFileSync(
      join(ocrDir, "config.yaml"),
      `runtime:\n  forward_resume_max_attempts: 0\n`,
    );
    expect(getForwardResumeMaxAttempts(ocrDir)).toBe(
      DEFAULT_FORWARD_RESUME_MAX_ATTEMPTS,
    );
  });

  it("falls back to the safe default for a non-integer value", () => {
    writeFileSync(
      join(ocrDir, "config.yaml"),
      `runtime:\n  forward_resume_max_attempts: "abc"\n`,
    );
    expect(getForwardResumeMaxAttempts(ocrDir)).toBe(
      DEFAULT_FORWARD_RESUME_MAX_ATTEMPTS,
    );
  });
});

describe("getForwardResumeLeaseMs", () => {
  it("returns the default (in ms) when config.yaml does not exist", () => {
    expect(getForwardResumeLeaseMs(ocrDir)).toBe(
      DEFAULT_FORWARD_RESUME_LEASE_SECONDS * 1000,
    );
  });

  it("reads runtime.forward_resume_lease_seconds and converts to ms", () => {
    writeFileSync(
      join(ocrDir, "config.yaml"),
      `runtime:\n  forward_resume_lease_seconds: 900\n`,
    );
    expect(getForwardResumeLeaseMs(ocrDir)).toBe(900 * 1000);
  });
});
