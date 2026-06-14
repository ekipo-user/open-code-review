import { describe, it, expect } from "vitest";
import {
  NODE_FLOOR,
  isSupportedNode,
  nodeVersionGuardMessage,
  isSuppressibleSqliteWarning,
} from "../runtime-checks.js";

describe("isSupportedNode (Node >= 22.5 floor for node:sqlite)", () => {
  it("accepts the floor and anything newer", () => {
    expect(isSupportedNode("22.5.0")).toBe(true); // exact floor
    expect(isSupportedNode("22.5.1")).toBe(true);
    expect(isSupportedNode("22.22.2")).toBe(true);
    expect(isSupportedNode("23.0.0")).toBe(true);
    expect(isSupportedNode("24.0.0")).toBe(true);
  });

  it("rejects anything below the floor", () => {
    expect(isSupportedNode("22.4.9")).toBe(false); // 22.4 < 22.5
    expect(isSupportedNode("22.0.0")).toBe(false);
    expect(isSupportedNode("20.18.0")).toBe(false); // EOL Node 20
    expect(isSupportedNode("18.20.0")).toBe(false);
  });
});

describe("nodeVersionGuardMessage", () => {
  it("names the required floor and the user's actual version", () => {
    const msg = nodeVersionGuardMessage("20.18.0");
    expect(msg).toContain(`>= ${NODE_FLOOR.major}.${NODE_FLOOR.minor}`);
    expect(msg).toContain("node:sqlite");
    expect(msg).toContain("20.18.0");
    expect(msg).not.toContain("Cannot find module");
  });
});

describe("isSuppressibleSqliteWarning", () => {
  it("matches only node:sqlite's experimental warning", () => {
    expect(
      isSuppressibleSqliteWarning("SQLite is an experimental feature and might change at any time"),
    ).toBe(true);
    expect(
      isSuppressibleSqliteWarning(new Error("SQLite is an experimental feature")),
    ).toBe(true);
  });

  it("never swallows other warnings", () => {
    expect(isSuppressibleSqliteWarning("Fetch API is an experimental feature")).toBe(false);
    expect(isSuppressibleSqliteWarning("DeprecationWarning: foo")).toBe(false);
    expect(isSuppressibleSqliteWarning(new Error("something else"))).toBe(false);
    expect(isSuppressibleSqliteWarning(undefined)).toBe(false);
  });
});
