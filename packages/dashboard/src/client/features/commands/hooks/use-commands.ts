import { useQuery } from '@tanstack/react-query'
import { fetchApi } from '../../../lib/utils'
import type { CommandEventsResponse, StreamEvent } from '../../../lib/api-types'

export type CommandHistoryEntry = {
  id: string
  command: string
  args: string | null
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  exit_code: number | null
  output: string
  /**
   * Server-derived from (exit_code, linked workflow.status). Distinguishes
   * a workflow that exited cleanly from one that exited 0 mid-flight (e.g.
   * macOS sleep dropped the streaming connection before the AI ever called
   * `ocr state finish`). Absent on rows from older server builds.
   */
  outcome?: 'success' | 'incomplete' | 'failed' | 'cancelled' | null
  /**
   * Orthogonal discriminator within the `outcome: 'cancelled'` bucket:
   * 'user' for an operator cancel (-2), 'cascade' for a child stopped
   * because its parent workflow closed (-4). Lets the UI label a
   * "Superseded" row without reaching past `outcome` to match a magic
   * exit-code number. Absent/null on non-cancelled rows and older builds.
   */
  cancellation_reason?: 'user' | 'cascade' | null
  // ── Agent-session journal fields (added by migration v11) ──
  workflow_id?: string | null
  vendor?: string | null
  vendor_session_id?: string | null
  resolved_model?: string | null
  last_heartbeat_at?: string | null
  notes?: string | null
}

export function useCommandHistory() {
  return useQuery<CommandHistoryEntry[]>({
    queryKey: ['command-history'],
    queryFn: () => fetchApi<CommandHistoryEntry[]>('/api/commands/history'),
  })
}

/**
 * Lazy-fetch the typed event stream for a specific completed execution.
 * Used by the history-row "Show timeline" toggle so we only pay the
 * network + JSONL parse cost when the user actually expands a row and
 * asks for the timeline view.
 *
 * Returns an empty events array (not 404) for executions that have no
 * journal — that's the signal to fall back to the legacy raw view.
 */
export function useCommandEvents(executionId: number | null, enabled: boolean) {
  return useQuery<StreamEvent[]>({
    queryKey: ['command-events', executionId],
    queryFn: async () => {
      if (executionId === null) return []
      const resp = await fetchApi<CommandEventsResponse>(
        `/api/commands/${executionId}/events`,
      )
      return resp.events ?? []
    },
    enabled: enabled && executionId !== null,
    // Events for a finished command are immutable; cache forever within a
    // session. Page refresh refetches naturally.
    staleTime: Infinity,
  })
}
