/**
 * OCR Models Command
 *
 * Surfaces the model identifiers the user's host AI CLI is willing to
 * accept, resolved through the per-vendor strategy table in
 * `lib/models.ts` (the single source of truth shared with the dashboard).
 * Strings are vendor-native — OCR does not coin its own logical names.
 * When native enumeration is unavailable the output is sourced from the
 * vendor's bundled list and the reason is disclosed. Free-text input
 * remains the canonical bypass.
 */

import { Command } from "commander";
import chalk from "chalk";
import {
  detectActiveVendor,
  isModelVendor,
  listModelsForVendor,
  SUPPORTED_VENDORS,
  type ModelVendor,
} from "@open-code-review/config/models";

const vendorList = SUPPORTED_VENDORS.join(" | ");

const listSubcommand = new Command("list")
  .description("List models the active AI CLI is willing to accept")
  .option("--vendor <vendor>", `Override autodetection (${vendorList})`)
  .option("--json", "Emit JSON for programmatic consumption")
  .action(async (options: { vendor?: string; json?: boolean }) => {
    let vendor: ModelVendor | null;
    if (options.vendor) {
      // Case-insensitive, matching the dashboard route's behavior.
      const requested = options.vendor.toLowerCase();
      if (!isModelVendor(requested)) {
        console.error(
          chalk.red(
            `Invalid --vendor: "${options.vendor}". Must be one of: ${vendorList}.`,
          ),
        );
        process.exit(1);
      }
      vendor = requested;
    } else {
      vendor = await detectActiveVendor();
      if (!vendor) {
        if (options.json) {
          // Mirrors the dashboard route's no-vendor envelope.
          console.log(
            JSON.stringify({ vendor: null, source: null, models: [] }, null, 2),
          );
          return;
        }
        console.error(
          chalk.yellow(
            "No supported AI CLI detected on PATH. Install Claude Code or OpenCode, or pass --vendor explicitly.",
          ),
        );
        process.exit(1);
      }
    }

    const result = await listModelsForVendor(vendor);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const { source, models, nativeUnavailableReason } = result;
    console.log(chalk.bold(`Models for ${vendor} (${source})`));
    if (source === "bundled") {
      const reason = nativeUnavailableReason
        ? ` — ${nativeUnavailableReason}`
        : "";
      console.log(
        chalk.dim(
          `  Note: bundled fallback list${reason}. Free-text input is always accepted.`,
        ),
      );
    }
    for (const model of models) {
      const label = model.displayName ? ` — ${model.displayName}` : "";
      const provider = model.provider ? chalk.dim(` [${model.provider}]`) : "";
      const tags =
        model.tags && model.tags.length > 0
          ? chalk.dim(` (${model.tags.join(", ")})`)
          : "";
      console.log(`  ${model.id}${label}${provider}${tags}`);
    }
  });

export const modelsCommand = new Command("models")
  .description("Inspect models available to the active AI CLI")
  .addCommand(listSubcommand);
