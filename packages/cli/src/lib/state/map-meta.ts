/**
 * Map-meta (map run) schema validation and derived-count helpers.
 *
 * Owns the `validateMapMeta` schema guard and `computeMapCounts`. Depends only
 * on the shared {@link sanitizeMetadataString} helper and the map-meta types —
 * no imports from the state barrel.
 */

import type { MapMeta } from "./types.js";
import { sanitizeMetadataString } from "./meta-util.js";

// ── Map-meta validation helpers ──

export function validateMapMeta(meta: unknown): MapMeta {
  if (!meta || typeof meta !== "object") {
    throw new Error("map-meta.json must be a JSON object");
  }

  const obj = meta as Record<string, unknown>;

  if (obj.schema_version !== 1) {
    throw new Error(
      `Unsupported schema_version: ${String(obj.schema_version)}. Expected 1.`,
    );
  }

  if (!Array.isArray(obj.sections)) {
    throw new Error("map-meta.json must contain a sections array");
  }

  for (const section of obj.sections) {
    if (!section || typeof section !== "object") {
      throw new Error("Each section must be an object");
    }
    const s = section as Record<string, unknown>;
    if (typeof s.section_number !== "number") {
      throw new Error("Each section must have a section_number");
    }
    if (typeof s.title !== "string" || s.title.trim().length === 0) {
      throw new Error("Each section must have a non-empty title");
    }
    s.title = sanitizeMetadataString(s.title);
    if (s.description !== undefined) {
      if (typeof s.description !== "string") {
        throw new Error(`Section "${s.title}" description must be a string if provided`);
      }
      s.description = sanitizeMetadataString(s.description);
    }
    if (!Array.isArray(s.files)) {
      throw new Error(`Section "${s.title}" must have a files array`);
    }
    for (const file of s.files) {
      if (!file || typeof file !== "object") {
        throw new Error("Each file must be an object");
      }
      const f = file as Record<string, unknown>;
      if (typeof f.file_path !== "string" || f.file_path.trim().length === 0) {
        throw new Error("Each file must have a non-empty file_path");
      }
      if (typeof f.role !== "string") {
        throw new Error(`File "${f.file_path}" must have a role string`);
      }
      f.role = sanitizeMetadataString(f.role);
      if (typeof f.lines_added !== "number") {
        throw new Error(`File "${f.file_path}" must have a lines_added number`);
      }
      if (typeof f.lines_deleted !== "number") {
        throw new Error(`File "${f.file_path}" must have a lines_deleted number`);
      }
    }
  }

  if (obj.dependencies !== undefined && !Array.isArray(obj.dependencies)) {
    throw new Error("map-meta.json dependencies must be an array if provided");
  }

  return meta as MapMeta;
}

/**
 * Compute derived counts from the sections array in a MapMeta.
 * Counts are NEVER self-reported — always derived from the data.
 */
export function computeMapCounts(meta: MapMeta): {
  sectionCount: number;
  fileCount: number;
} {
  return {
    sectionCount: meta.sections.length,
    fileCount: meta.sections.reduce((sum, s) => sum + s.files.length, 0),
  };
}
