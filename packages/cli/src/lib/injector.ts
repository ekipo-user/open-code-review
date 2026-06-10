import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AI_TOOLS,
  type AIToolConfig,
  type InstructionFileFormat,
  type InstructionFileTarget,
} from "./config.js";

/**
 * The universal cross-tool instruction file. Written for every `ocr init`
 * regardless of which tools are selected — it is the convention OCR itself
 * uses (`AGENTS.md`) and the file an increasing number of agentic CLIs read.
 */
const AGENTS_MD: InstructionFileTarget = { path: "AGENTS.md", format: "markdown" };

/**
 * Managed-block markers per format. The body between them is identical; only
 * the delimiters differ so non-markdown files (.windsurfrules) don't show
 * literal HTML comments.
 */
const MARKERS: Record<InstructionFileFormat, { start: string; end: string }> = {
  markdown: { start: "<!-- OCR:START -->", end: "<!-- OCR:END -->" },
  plaintext: { start: "# OCR:START", end: "# OCR:END" },
};

const OCR_INSTRUCTION_BODY = `## Open Code Review Instructions

These instructions are for AI assistants handling code review in this project.

Always open \`.ocr/skills/SKILL.md\` when the request:
- Asks for code review, PR review, or feedback on changes
- Mentions "review my code" or similar phrases
- Wants multi-perspective analysis of code quality
- Asks to map, organize, or navigate a large changeset

Use \`.ocr/skills/SKILL.md\` to learn:
- How to run the 8-phase review workflow
- How to generate a Code Review Map for large changesets
- Available reviewer personas and their focus areas
- Session management and output format

Keep this managed block so \`ocr init\` can refresh the instructions.`;

function buildBlock(format: InstructionFileFormat): string {
  const { start, end } = MARKERS[format];
  return `${start}\n${OCR_INSTRUCTION_BODY}\n${end}`;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function blockRegex(format: InstructionFileFormat): RegExp {
  const { start, end } = MARKERS[format];
  return new RegExp(
    `${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}\\n?`,
    "g",
  );
}

/**
 * Insert or refresh the OCR managed block in a single file, preserving any
 * surrounding user content. Idempotent: an existing block of the same format
 * is stripped before the current one is appended.
 */
export function injectOcrInstructions(
  filePath: string,
  format: InstructionFileFormat = "markdown",
): boolean {
  try {
    mkdirSync(dirname(filePath), { recursive: true });

    let content = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
    content = content.replace(blockRegex(format), "");

    content = content.trim();
    if (content.length > 0) {
      content += "\n\n";
    }
    content += buildBlock(format) + "\n";

    writeFileSync(filePath, content);
    return true;
  } catch {
    return false;
  }
}

export type InjectionResult = {
  /** Repo-relative paths that got or refreshed an OCR managed block. */
  written: string[];
  /** Repo-relative paths that failed to write. */
  failed: string[];
};

/**
 * Resolve the de-duplicated set of instruction-file targets for a tool
 * selection: always `AGENTS.md`, plus each selected tool's native file(s),
 * written at most once.
 */
function resolveTargets(selectedTools: AIToolConfig[]): InstructionFileTarget[] {
  const targets = new Map<string, InstructionFileTarget>();
  targets.set(AGENTS_MD.path, AGENTS_MD);
  for (const tool of selectedTools) {
    for (const file of tool.instructionFiles ?? []) {
      targets.set(file.path, file);
    }
  }
  return [...targets.values()];
}

/**
 * The repo-relative paths `injectIntoProjectFiles` would write for a tool
 * selection — used by `ocr update --dry-run` to preview without writing.
 */
export function plannedInstructionFiles(selectedTools: AIToolConfig[]): string[] {
  return resolveTargets(selectedTools).map((t) => t.path);
}

/**
 * Inject OCR instructions into the instruction files for the selected tools.
 *
 * Always writes the universal `AGENTS.md`, plus each selected tool's native
 * instruction file(s). Files are de-duplicated so `AGENTS.md` (and any file
 * two tools happen to share) is written exactly once — e.g. selecting only
 * Gemini writes `AGENTS.md` + `GEMINI.md` and never a stray `CLAUDE.md`.
 */
export function injectIntoProjectFiles(
  targetDir: string,
  selectedTools: AIToolConfig[],
): InjectionResult {
  const written: string[] = [];
  const failed: string[] = [];
  for (const target of resolveTargets(selectedTools)) {
    const ok = injectOcrInstructions(join(targetDir, target.path), target.format);
    (ok ? written : failed).push(target.path);
  }

  return { written, failed };
}

export function hasOcrInstructions(filePath: string): boolean {
  if (!existsSync(filePath)) {
    return false;
  }

  const content = readFileSync(filePath, "utf-8");
  return Object.values(MARKERS).some(
    (m) => content.includes(m.start) && content.includes(m.end),
  );
}

/**
 * Find native instruction files (across all known tools) that still carry an
 * OCR managed block but are NOT part of the files just written — e.g. a stray
 * `CLAUDE.md` left over from an init that selected Claude, after the user
 * switches to a non-Claude tool. `AGENTS.md` is universal and never stale.
 *
 * Returns repo-relative paths; the caller decides what to do (we only warn —
 * we never delete user-owned files).
 */
export function findStaleInstructionFiles(
  targetDir: string,
  writtenPaths: string[],
): string[] {
  const written = new Set(writtenPaths);
  const candidates = new Set<string>();
  for (const tool of AI_TOOLS) {
    for (const file of tool.instructionFiles ?? []) {
      candidates.add(file.path);
    }
  }

  const stale: string[] = [];
  for (const path of candidates) {
    if (written.has(path)) continue;
    if (hasOcrInstructions(join(targetDir, path))) {
      stale.push(path);
    }
  }
  return stale;
}

/**
 * Format the human-facing warning lines for stale instruction files, so the
 * copy lives in one place instead of being re-typed at each `init`/`update`
 * call site. `dry-run` frames them as "left untouched"; the live paths frame
 * them as a manual-cleanup nudge (OCR never deletes user-owned files).
 */
export function formatStaleWarnings(
  stale: string[],
  mode: "init" | "update" | "dry-run",
): string[] {
  if (mode === "dry-run") {
    return stale.map((path) => `${path} (stale OCR block — left untouched)`);
  }
  const owner = mode === "init" ? "installed" : "configured";
  return stale.map(
    (path) =>
      `${path} still has an OCR block but no ${owner} tool uses it — remove it manually if unneeded.`,
  );
}
