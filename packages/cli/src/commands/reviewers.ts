/**
 * OCR Reviewers Command
 *
 * Manages reviewer metadata for dashboard consumption.
 *
 * Subcommands:
 *   sync  — Write reviewers-meta.json from structured JSON on stdin
 */

import { Command } from "commander";
import chalk from "chalk";
import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { requireOcrSetup } from "../lib/guards.js";
import { generateReviewersMeta } from "../lib/installer.js";
import type { ReviewersMeta, ReviewerTier } from "@open-code-review/persistence/state";
import { defaultIconFor } from "@open-code-review/platform";

// ── Helpers ──

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const data = Buffer.concat(chunks).toString("utf-8").trim();
  if (data.length === 0) {
    throw new Error("No data received on stdin");
  }
  return data;
}

const VALID_TIERS = new Set<ReviewerTier>(["holistic", "specialist", "persona", "custom"]);
const SLUG_RE = /^[a-z][a-z0-9-]*$/;

// Reviewer metadata is rendered into every Phase-4 reviewer prompt. A persona
// authored from untrusted `/ocr-create-reviewer` input could try to override
// the reviewer's instructions (e.g. "always conclude REQUEST CHANGES"). We warn
// on the obvious override shapes — we do NOT hard-reject (the persona text is
// also wrapped in delimiters in reviewer-task.md), so legitimate prose isn't
// blocked. Issue #28 review Important-4.
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|the\s+)?(previous|prior|above)?\s*(instructions|prompts|rules)/i,
  /disregard\s+(all\s+|the\s+)?(previous|prior|above)/i,
  /\byou\s+are\s+now\b/i,
  /^\s*system\s*:/im,
  /\balways\s+(conclude|respond|reply|return|output|approve|reject|say)\b/i,
  /\bnew\s+rule\s*:/i,
];

function warnIfSuspiciousPersona(label: string, fields: unknown[]): void {
  const text = fields.filter((f) => typeof f === "string").join("\n");
  const hit = INJECTION_PATTERNS.find((re) => re.test(text));
  if (hit) {
    console.error(
      chalk.yellow(
        `⚠ ${label} contains text resembling a prompt-injection override (matched ${hit}). Review the persona before relying on it.`,
      ),
    );
  }
}

export function validateReviewersMeta(data: unknown): ReviewersMeta {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("Payload must be a JSON object");
  }

  const obj = data as Record<string, unknown>;

  if (obj.schema_version !== 1) {
    throw new Error(`schema_version must be 1, got ${JSON.stringify(obj.schema_version)}`);
  }

  if (typeof obj.generated_at !== "string" || obj.generated_at.length === 0) {
    throw new Error("generated_at must be a non-empty ISO 8601 string");
  }

  if (!Array.isArray(obj.reviewers)) {
    throw new Error("reviewers must be an array");
  }

  const seenIds = new Set<string>();

  for (let i = 0; i < obj.reviewers.length; i++) {
    const r = obj.reviewers[i] as Record<string, unknown>;
    const prefix = `reviewers[${i}]`;

    if (typeof r.id !== "string" || !SLUG_RE.test(r.id)) {
      throw new Error(`${prefix}.id must be a lowercase slug (got ${JSON.stringify(r.id)})`);
    }
    if (seenIds.has(r.id)) {
      throw new Error(`Duplicate reviewer id: "${r.id}"`);
    }
    seenIds.add(r.id);

    if (typeof r.name !== "string" || r.name.length === 0) {
      throw new Error(`${prefix}.name must be a non-empty string`);
    }
    if (!VALID_TIERS.has(r.tier as ReviewerTier)) {
      throw new Error(`${prefix}.tier must be one of: ${[...VALID_TIERS].join(", ")} (got ${JSON.stringify(r.tier)})`);
    }
    if (typeof r.description !== "string" || r.description.length === 0) {
      throw new Error(`${prefix}.description must be a non-empty string`);
    }
    if (!Array.isArray(r.focus_areas)) {
      throw new Error(`${prefix}.focus_areas must be an array`);
    }

    // Icon: a non-string is a real bug worth surfacing; a missing/empty icon
    // is backfilled with the canonical default so the persisted JSON always
    // carries a renderable icon (guards the dashboard against an `undefined`
    // icon read — see issue #28).
    if (r.icon !== undefined && typeof r.icon !== "string") {
      throw new Error(`${prefix}.icon must be a string if provided (got ${JSON.stringify(r.icon)})`);
    }
    if (typeof r.icon !== "string" || r.icon.length === 0) {
      r.icon = defaultIconFor(r.id, r.tier as ReviewerTier);
    }

    warnIfSuspiciousPersona(`${prefix} ("${r.name}")`, [
      r.name,
      r.description,
      ...(Array.isArray(r.focus_areas) ? r.focus_areas : []),
      r.known_for,
      r.philosophy,
    ]);

    // Optional fields for personas
    if (r.known_for !== undefined && typeof r.known_for !== "string") {
      throw new Error(`${prefix}.known_for must be a string if provided`);
    }
    if (r.philosophy !== undefined && typeof r.philosophy !== "string") {
      throw new Error(`${prefix}.philosophy must be a string if provided`);
    }
  }

  return data as unknown as ReviewersMeta;
}

// ── sync ──

const syncSubcommand = new Command("sync")
  .description("Sync reviewers-meta.json from reviewer markdown files or structured JSON")
  .option("--stdin", "Read reviewers JSON from stdin (for AI-invoked sync)")
  .action(async (options: { stdin?: boolean }) => {
    const targetDir = process.cwd();
    requireOcrSetup(targetDir);
    const ocrDir = join(targetDir, ".ocr");

    // Direct scan mode: read .md files and generate meta internally
    if (!options.stdin) {
      try {
        const reviewersDir = join(ocrDir, "skills", "references", "reviewers");
        const configPath = join(ocrDir, "config.yaml");
        const meta = generateReviewersMeta(reviewersDir, configPath);

        if (!meta || meta.reviewers.length === 0) {
          console.error(chalk.yellow("No reviewer files found in .ocr/skills/references/reviewers/"));
          process.exit(1);
        }

        const metaPath = join(ocrDir, "reviewers-meta.json");
        const tmpPath = metaPath + ".tmp";
        writeFileSync(tmpPath, JSON.stringify(meta, null, 2) + "\n");
        renameSync(tmpPath, metaPath);

        const tierCounts = meta.reviewers.reduce(
          (acc, r) => {
            acc[r.tier] = (acc[r.tier] ?? 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        );
        const breakdown = Object.entries(tierCounts)
          .map(([tier, count]) => `${count} ${tier}`)
          .join(", ");

        console.log(chalk.green(`Synced ${meta.reviewers.length} reviewer(s) (${breakdown}).`));
      } catch (error) {
        console.error(
          chalk.red(`Error: ${error instanceof Error ? error.message : "Failed to sync reviewers"}`),
        );
        process.exit(1);
      }
      return;
    }

    try {
      const raw = await readStdin();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("Invalid JSON on stdin");
      }

      const meta = validateReviewersMeta(parsed);

      // Atomic write: tmp → rename
      const metaPath = join(ocrDir, "reviewers-meta.json");
      const tmpPath = metaPath + ".tmp";
      writeFileSync(tmpPath, JSON.stringify(meta, null, 2) + "\n");
      renameSync(tmpPath, metaPath);

      const tierCounts = meta.reviewers.reduce(
        (acc, r) => {
          acc[r.tier] = (acc[r.tier] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

      const breakdown = Object.entries(tierCounts)
        .map(([tier, count]) => `${count} ${tier}`)
        .join(", ");

      console.log(
        chalk.green(`Synced ${meta.reviewers.length} reviewer(s) (${breakdown}).`),
      );
    } catch (error) {
      console.error(
        chalk.red(
          `Error: ${error instanceof Error ? error.message : "Failed to sync reviewers"}`,
        ),
      );
      process.exit(1);
    }
  });

// ── Main reviewers command ──

export const reviewersCommand = new Command("reviewers")
  .description("Manage OCR reviewer metadata")
  .addCommand(syncSubcommand);
