/**
 * Bin-only fast-fail Node-version guard. `src/index.ts` imports this FIRST so an
 * `ocr` command on a too-old runtime exits with a clean message *before* doing
 * any work, rather than failing mid-command.
 *
 * This is a UX nicety layered on top of the STRUCTURAL guard: the engine load
 * itself (`db/engine.ts`) also refuses to load `node:sqlite` on Node < 22.5 and
 * suppresses the experimental warning, so library / dashboard-server entry
 * points that never import this module are still guarded by construction. The
 * pure decision logic lives in `runtime-checks.ts`.
 */

import { isSupportedNode, nodeVersionGuardMessage } from "@open-code-review/persistence/runtime-checks";

if (!isSupportedNode(process.versions.node)) {
  process.stderr.write(nodeVersionGuardMessage(process.versions.node));
  process.exit(1);
}
