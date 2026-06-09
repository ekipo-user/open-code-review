import { describe, it, expect } from "vitest";
import { sanitizeMetadataString } from "../meta-util.js";

/**
 * Unit coverage for the SF12 prompt-/log-injection defense. Asserts the real
 * observable behavior of {@link sanitizeMetadataString}: C0 control chars are
 * stripped (neutralizing ANSI/escape injection and embedded NULs) while `\t`
 * and `\n` survive, a leading `[ocr]` prefix is removed (so a finding can't
 * spoof the CLI's own machine-readable log lines), and the output is capped.
 */
describe("sanitizeMetadataString", () => {
  it("strips an embedded ANSI escape (\\x1b)", () => {
    const out = sanitizeMetadataString("red\x1b[31mtext");
    // The ESC byte is removed; the surrounding (printable) bytes survive.
    expect(out).not.toContain("\x1b");
    expect(out).toBe("red[31mtext");
  });

  it("strips an embedded NUL (\\x00)", () => {
    const out = sanitizeMetadataString("a\x00b");
    expect(out).not.toContain("\x00");
    expect(out).toBe("ab");
  });

  it("strips other C0 control characters (e.g. \\x07 BEL, \\x1f)", () => {
    const out = sanitizeMetadataString("x\x07y\x1fz");
    expect(out).toBe("xyz");
  });

  it("preserves a tab (\\t)", () => {
    expect(sanitizeMetadataString("col1\tcol2")).toBe("col1\tcol2");
  });

  it("preserves a newline (\\n)", () => {
    expect(sanitizeMetadataString("line1\nline2")).toBe("line1\nline2");
  });

  it("strips a leading [ocr] prefix (case-insensitive)", () => {
    expect(sanitizeMetadataString("[ocr] hello")).toBe("hello");
    expect(sanitizeMetadataString("[OCR] hello")).toBe("hello");
    expect(sanitizeMetadataString("[Ocr] hello")).toBe("hello");
  });

  it("strips a leading [ocr] prefix with leading whitespace", () => {
    expect(sanitizeMetadataString("   [ocr] hello")).toBe("hello");
    expect(sanitizeMetadataString("\t[ocr]hello")).toBe("hello");
  });

  it("only strips the prefix when it leads (no mid-string removal)", () => {
    expect(sanitizeMetadataString("danger [ocr] here")).toBe("danger [ocr] here");
  });

  it("truncates a string longer than 4096 chars to 4096", () => {
    const out = sanitizeMetadataString("a".repeat(5000));
    expect(out).toHaveLength(4096);
  });

  it("does not truncate a string at or under 4096 chars", () => {
    const exact = "b".repeat(4096);
    expect(sanitizeMetadataString(exact)).toHaveLength(4096);
    expect(sanitizeMetadataString("short")).toBe("short");
  });

  it("honors a custom maxLen", () => {
    expect(sanitizeMetadataString("abcdef", { maxLen: 3 })).toBe("abc");
  });

  it("leaves a clean string untouched", () => {
    expect(sanitizeMetadataString("a normal review summary")).toBe(
      "a normal review summary",
    );
  });
});
