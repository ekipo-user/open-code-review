import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  injectOcrInstructions,
  injectIntoProjectFiles,
  hasOcrInstructions,
  plannedInstructionFiles,
  findStaleInstructionFiles,
} from "../injector.js";
import { getToolById, type AIToolId } from "../config.js";

function tools(...ids: AIToolId[]) {
  return ids.map((id) => {
    const tool = getToolById(id);
    if (!tool) throw new Error(`Unknown tool id in test: ${id}`);
    return tool;
  });
}

describe("injector", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "ocr-injector-test-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function read(name: string): string {
    return readFileSync(join(projectDir, name), "utf-8");
  }

  function write(name: string, content: string): void {
    writeFileSync(join(projectDir, name), content);
  }

  describe("OCR managed-block content", () => {
    it("uses h2 (##) for the heading, not h1 (#)", () => {
      const path = join(projectDir, "CLAUDE.md");
      injectOcrInstructions(path);

      const content = read("CLAUDE.md");
      expect(content).toContain("## Open Code Review Instructions");
      // Guard against regression to h1 (a line starting with `# ` not `## `)
      expect(content).not.toMatch(/^# Open Code Review Instructions$/m);
    });

    it("uses backticks around `ocr init`, not single quotes", () => {
      const path = join(projectDir, "CLAUDE.md");
      injectOcrInstructions(path);

      const content = read("CLAUDE.md");
      expect(content).toContain("`ocr init`");
      expect(content).not.toContain("'ocr init'");
    });

    it("includes the start and end markers", () => {
      const path = join(projectDir, "CLAUDE.md");
      injectOcrInstructions(path);

      const content = read("CLAUDE.md");
      expect(content).toContain("<!-- OCR:START -->");
      expect(content).toContain("<!-- OCR:END -->");
    });
  });

  describe("injectOcrInstructions", () => {
    it("creates a file with the managed block when none exists", () => {
      const path = join(projectDir, "CLAUDE.md");
      const result = injectOcrInstructions(path);

      expect(result).toBe(true);
      expect(existsSync(path)).toBe(true);
      const content = read("CLAUDE.md");
      expect(content).toContain("<!-- OCR:START -->");
      expect(content).toContain(".ocr/skills/SKILL.md");
    });

    it("appends managed block while preserving existing content", () => {
      write("CLAUDE.md", "# My Project\n\nSome instructions here.\n");

      injectOcrInstructions(join(projectDir, "CLAUDE.md"));

      const content = read("CLAUDE.md");
      expect(content).toContain("# My Project");
      expect(content).toContain("Some instructions here.");
      expect(content).toContain("<!-- OCR:START -->");
    });

    it("replaces existing managed block on re-inject (idempotent)", () => {
      const path = join(projectDir, "CLAUDE.md");

      injectOcrInstructions(path);
      const first = read("CLAUDE.md");

      injectOcrInstructions(path);
      const second = read("CLAUDE.md");

      expect(second).toBe(first);
      expect(second.match(/<!-- OCR:START -->/g)?.length).toBe(1);
      expect(second.match(/<!-- OCR:END -->/g)?.length).toBe(1);
    });

    it("replaces a stale managed block with the current template", () => {
      write(
        "CLAUDE.md",
        [
          "# My Project",
          "",
          "<!-- OCR:START -->",
          "# Old Heading",
          "stale content",
          "<!-- OCR:END -->",
        ].join("\n") + "\n",
      );

      injectOcrInstructions(join(projectDir, "CLAUDE.md"));

      const content = read("CLAUDE.md");
      expect(content).toContain("# My Project");
      expect(content).not.toContain("# Old Heading");
      expect(content).not.toContain("stale content");
      expect(content).toContain("## Open Code Review Instructions");
      expect(content.match(/<!-- OCR:START -->/g)?.length).toBe(1);
    });
  });

  describe("injectIntoProjectFiles — per-tool instruction files (issue #28)", () => {
    it("always writes the universal AGENTS.md", () => {
      const result = injectIntoProjectFiles(projectDir, tools("codex"));
      expect(result.written).toContain("AGENTS.md");
      expect(read("AGENTS.md")).toContain("<!-- OCR:START -->");
    });

    it("[claude] writes AGENTS.md + CLAUDE.md", () => {
      const result = injectIntoProjectFiles(projectDir, tools("claude"));
      expect(result.written.sort()).toEqual(["AGENTS.md", "CLAUDE.md"]);
      expect(read("CLAUDE.md")).toContain("<!-- OCR:START -->");
    });

    it("[codex] writes AGENTS.md only — no stray CLAUDE.md", () => {
      injectIntoProjectFiles(projectDir, tools("codex"));
      expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(true);
      expect(existsSync(join(projectDir, "CLAUDE.md"))).toBe(false);
    });

    it("[gemini] writes GEMINI.md, not CLAUDE.md", () => {
      const result = injectIntoProjectFiles(projectDir, tools("gemini"));
      expect(result.written.sort()).toEqual(["AGENTS.md", "GEMINI.md"]);
      expect(existsSync(join(projectDir, "CLAUDE.md"))).toBe(false);
      expect(read("GEMINI.md")).toContain("<!-- OCR:START -->");
    });

    it("[github-copilot] writes the nested .github/copilot-instructions.md", () => {
      injectIntoProjectFiles(projectDir, tools("github-copilot"));
      const nested = join(projectDir, ".github", "copilot-instructions.md");
      expect(existsSync(nested)).toBe(true);
      expect(readFileSync(nested, "utf-8")).toContain("<!-- OCR:START -->");
    });

    it("[windsurf] writes .windsurfrules with plaintext markers, not HTML comments", () => {
      injectIntoProjectFiles(projectDir, tools("windsurf"));
      const content = read(".windsurfrules");
      expect(content).toContain("# OCR:START");
      expect(content).toContain("# OCR:END");
      expect(content).not.toContain("<!-- OCR:START -->");
      expect(hasOcrInstructions(join(projectDir, ".windsurfrules"))).toBe(true);
    });

    it("writes AGENTS.md exactly once across multiple tools", () => {
      const result = injectIntoProjectFiles(projectDir, tools("claude", "codex", "gemini"));
      expect(result.written.filter((p) => p === "AGENTS.md")).toHaveLength(1);
      expect(result.written.sort()).toEqual(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
      expect(read("AGENTS.md").match(/<!-- OCR:START -->/g)).toHaveLength(1);
    });

    it("preserves existing user content in a native file", () => {
      write("CLAUDE.md", "# My Project\n\nHouse rules.\n");
      injectIntoProjectFiles(projectDir, tools("claude"));
      const content = read("CLAUDE.md");
      expect(content).toContain("# My Project");
      expect(content).toContain("House rules.");
      expect(content).toContain("<!-- OCR:START -->");
    });
  });

  describe("plannedInstructionFiles", () => {
    it("previews the same paths injection would write", () => {
      expect(plannedInstructionFiles(tools("gemini")).sort()).toEqual([
        "AGENTS.md",
        "GEMINI.md",
      ]);
      expect(plannedInstructionFiles(tools("codex"))).toEqual(["AGENTS.md"]);
    });
  });

  describe("findStaleInstructionFiles", () => {
    it("flags a leftover CLAUDE.md when the selection no longer includes Claude", () => {
      // Simulate an earlier claude init, then a gemini-only run.
      injectIntoProjectFiles(projectDir, tools("claude"));
      const result = injectIntoProjectFiles(projectDir, tools("gemini"));

      const stale = findStaleInstructionFiles(projectDir, result.written);
      expect(stale).toContain("CLAUDE.md");
    });

    it("never flags AGENTS.md (universal) and ignores files without an OCR block", () => {
      const result = injectIntoProjectFiles(projectDir, tools("claude"));
      const stale = findStaleInstructionFiles(projectDir, result.written);
      expect(stale).not.toContain("AGENTS.md");
      expect(stale).toHaveLength(0);
    });
  });

  describe("hasOcrInstructions", () => {
    it("returns false when the file does not exist", () => {
      expect(hasOcrInstructions(join(projectDir, "CLAUDE.md"))).toBe(false);
    });

    it("returns false when the file exists but lacks markers", () => {
      write("CLAUDE.md", "# My Project\n");
      expect(hasOcrInstructions(join(projectDir, "CLAUDE.md"))).toBe(false);
    });

    it("returns true when both markers are present", () => {
      const path = join(projectDir, "CLAUDE.md");
      injectOcrInstructions(path);
      expect(hasOcrInstructions(path)).toBe(true);
    });
  });
});
