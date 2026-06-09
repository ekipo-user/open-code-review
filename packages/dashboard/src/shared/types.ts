// Shared types between dashboard client and server
// Socket.IO event types, API response types, etc.

export type SessionStatus = 'active' | 'closed'

/**
 * Final state of a command_executions row, derived from
 * (exit_code, linked workflow's session.status). Surfaced to the client
 * so the UI can distinguish a workflow that exited cleanly from one that
 * exited 0 mid-flight (e.g. parent process died on macOS sleep before the
 * AI ever called `ocr state finish`).
 *
 *  - 'success'    — exit 0 AND (no linked workflow | workflow.status='closed')
 *  - 'incomplete' — exit 0 BUT workflow exists and is still 'active'
 *  - 'failed'     — non-zero exit code (excluding cancel sentinel)
 *  - 'cancelled'  — exit code -2 (cancel sentinel from finishExecution)
 *  - null         — command not finished yet
 */
export type CommandOutcome = 'success' | 'incomplete' | 'failed' | 'cancelled'
export type WorkflowType = 'review' | 'map'
export type FindingTriage = 'unread' | 'read' | 'acknowledged' | 'fixed' | 'wont_fix'
export type RoundTriage = 'needs_review' | 'in_progress' | 'changes_made' | 'acknowledged' | 'dismissed'
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type NoteTargetType = 'session' | 'round' | 'finding' | 'run' | 'section' | 'file'
export type ChatTargetType = 'map_run' | 'review_round'
export type PostReviewStep = 'idle' | 'checking' | 'ready' | 'generating' | 'preview' | 'posting' | 'posted' | 'error'

// ── Reviewers Meta (structured reviewer catalog for dashboard) ──

export type ReviewerTier = 'holistic' | 'specialist' | 'persona' | 'custom'

export type ReviewerMeta = {
  id: string
  name: string
  tier: ReviewerTier
  icon: string
  description: string
  focus_areas: string[]
  is_default: boolean
  is_builtin: boolean
  known_for?: string
  philosophy?: string
}
