/**
 * Generic row-mapping utilities for engine exec() results.
 *
 * Extracted to its own module to break the circular dependency between
 * db/index.ts (which re-exports from queries.ts) and queries.ts (which
 * needs these helpers).
 */

import type { ExecResult } from "./engine.js";

/**
 * Converts a sql.js exec() result set into an array of typed row objects.
 */
export function resultToRows<T>(result: ExecResult): T[] {
  if (result.length === 0 || !result[0]) {
    return [];
  }
  const { columns, values } = result[0];
  return values.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i] as string] = row[i];
    }
    return obj as T;
  });
}

/**
 * Converts a sql.js exec() result set into a single typed row, or undefined.
 */
export function resultToRow<T>(result: ExecResult): T | undefined {
  const rows = resultToRows<T>(result);
  return rows[0];
}
