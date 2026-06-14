import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_AGENT_HEARTBEAT_SECONDS,
  DEFAULT_WORKFLOW_HARD_DEADLINE_MINUTES,
  getAgentHeartbeatSeconds,
  getWorkflowHardDeadlineMs,
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
