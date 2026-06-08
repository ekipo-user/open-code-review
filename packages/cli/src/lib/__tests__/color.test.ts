import { describe, it, expect, afterEach } from "vitest";
import chalk from "chalk";
import { resolveColorLevel, initColor } from "../color.js";

const tty = { isTTY: true } as NodeJS.WriteStream;
const pipe = { isTTY: false } as NodeJS.WriteStream;

describe("resolveColorLevel", () => {
  it("disables color when piped (non-TTY) — no ANSI in captured output", () => {
    expect(resolveColorLevel(pipe, {})).toBe(0);
    expect(resolveColorLevel(undefined, {})).toBe(0);
  });

  it("enables color on a TTY (the case dev masked with FORCE_COLOR)", () => {
    expect(resolveColorLevel(tty, {})).toBe(1);
    expect(resolveColorLevel(tty, { TERM: "xterm-256color" })).toBe(2);
    expect(resolveColorLevel(tty, { COLORTERM: "truecolor" })).toBe(3);
  });

  it("honors NO_COLOR (any non-empty value) even on a TTY", () => {
    expect(resolveColorLevel(tty, { NO_COLOR: "1" })).toBe(0);
    expect(resolveColorLevel(tty, { NO_COLOR: "anything" })).toBe(0);
    // Empty NO_COLOR is not set per the spec.
    expect(resolveColorLevel(tty, { NO_COLOR: "" })).toBe(1);
  });

  it("honors FORCE_COLOR over TTY detection (the dev path / dashboard subprocesses)", () => {
    expect(resolveColorLevel(pipe, { FORCE_COLOR: "1" })).toBe(1);
    expect(resolveColorLevel(pipe, { FORCE_COLOR: "3" })).toBe(3);
    expect(resolveColorLevel(pipe, { FORCE_COLOR: "" })).toBe(1);
    expect(resolveColorLevel(pipe, { FORCE_COLOR: "true" })).toBe(1);
    expect(resolveColorLevel(tty, { FORCE_COLOR: "0" })).toBe(0);
    expect(resolveColorLevel(tty, { FORCE_COLOR: "false" })).toBe(0);
  });
});

describe("initColor", () => {
  const original = chalk.level;
  afterEach(() => {
    chalk.level = original;
  });

  it("pins chalk.level and actually emits ANSI on a TTY", () => {
    initColor(tty, {});
    expect(chalk.level).toBe(1);
    expect(chalk.red("x")).toContain("["); // real ANSI escape
  });

  it("pins chalk.level to 0 (no ANSI) when piped", () => {
    initColor(pipe, {});
    expect(chalk.level).toBe(0);
    expect(chalk.red("x")).toBe("x");
  });
});
