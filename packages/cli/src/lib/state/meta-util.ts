/**
 * Shared metadata-sanitization helper used by both the round-meta and
 * map-meta validators. Leaf module — no imports from the state barrel.
 */

const DEFAULT_METADATA_MAX_LEN = 4096;

/**
 * Defang an orchestrator-supplied free-text field before it is persisted and
 * later rendered (dashboard, stderr logs, agent prompts):
 *
 *   - strips C0 control chars (\x00-\x1f) except tab (\t) and newline (\n),
 *     which neutralizes ANSI/escape injection and embedded NULs;
 *   - strips a leading "[ocr]" prefix (case-insensitive), reserved for the
 *     CLI's own machine-readable log lines, so a finding can't spoof one;
 *   - caps the length to `maxLen` to bound storage + render cost.
 */
export function sanitizeMetadataString(
  s: string,
  opts: { maxLen?: number } = {},
): string {
  const maxLen = opts.maxLen ?? DEFAULT_METADATA_MAX_LEN;
  // eslint-disable-next-line no-control-regex
  let out = s.replace(/[\x00-\x08\x0b-\x1f]/g, "");
  out = out.replace(/^\s*\[ocr\]\s*/i, "");
  if (out.length > maxLen) out = out.slice(0, maxLen);
  return out;
}
