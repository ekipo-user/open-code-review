import { CheckCircle2, XCircle, MessageCircle, HelpCircle, AlertTriangle } from 'lucide-react'
import { normalizeVerdict, type CanonicalVerdict } from '@open-code-review/platform/verdict'
import { cn } from '../../lib/utils'

type VerdictBannerProps = {
  /** Free-form verdict string from the store. Normalized through the shared
   *  {@link normalizeVerdict} to the canonical merge-gate vocabulary
   *  (`APPROVE` / `REQUEST CHANGES` / `NEEDS DISCUSSION`); anything that cannot
   *  be confidently mapped renders a neutral fallback rather than crashing or
   *  inventing a gate. */
  verdict: string
  blockerCount?: number
  suggestionCount?: number
  shouldFixCount?: number
  className?: string
}

type VerdictConfig = {
  icon: typeof CheckCircle2
  bg: string
  border: string
  text: string
  label: string
}

/**
 * The verdict is exactly one axis: the **merge gate**. Three canonical states,
 * keyed verbatim by the shared {@link CanonicalVerdict} union. Residual work
 * (follow-ups, suggestions) is a separate axis carried by the finding counts
 * and rendered as a subordinate chip — never folded into the gate label.
 */
const VERDICT_CONFIG: Record<CanonicalVerdict, VerdictConfig> = {
  APPROVE: {
    icon: CheckCircle2,
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/30',
    text: 'text-emerald-700 dark:text-emerald-400',
    label: 'Approve',
  },
  'REQUEST CHANGES': {
    icon: XCircle,
    bg: 'bg-red-500/10',
    border: 'border-red-500/30',
    text: 'text-red-700 dark:text-red-400',
    label: 'Request Changes',
  },
  'NEEDS DISCUSSION': {
    icon: MessageCircle,
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/30',
    text: 'text-amber-700 dark:text-amber-400',
    label: 'Needs Discussion',
  },
}

const UNKNOWN_VERDICT_CONFIG: VerdictConfig = {
  icon: HelpCircle,
  bg: 'bg-zinc-500/10',
  border: 'border-zinc-500/30',
  text: 'text-zinc-700 dark:text-zinc-300',
  label: 'Verdict',
}

/**
 * Resolve the gate config from a raw verdict by routing through the shared
 * normalizer. A canonical state gets its dedicated style; an unmappable value
 * falls back to a neutral "Verdict" badge that echoes the raw text (capped) so
 * a legacy or malformed row degrades gracefully instead of misrepresenting the
 * gate.
 */
function resolveConfig(verdict: string): VerdictConfig {
  const canonical = normalizeVerdict(verdict)
  if (canonical) return VERDICT_CONFIG[canonical]
  const trimmed = verdict.trim()
  const label = trimmed.length > 60 ? `${trimmed.slice(0, 60).trim()}…` : trimmed
  return { ...UNKNOWN_VERDICT_CONFIG, label: label || 'Verdict' }
}

/**
 * Whether a verdict contradicts its blocker count in *direction*. This is a
 * legacy-row concern only: the CLI's directional gate now prevents new rows where
 * `APPROVE` carries a non-zero blocker count or `REQUEST CHANGES` carries zero.
 * Older rows, written before that gate, can still disagree — surface a hint
 * rather than rewrite the stored row. Returns false when the blocker count is
 * unknown, when the verdict is unmappable, or for `NEEDS DISCUSSION` (which is
 * unconstrained on blockers).
 */
export function hasVerdictMismatch(verdict: string, blockerCount?: number): boolean {
  if (blockerCount == null) return false
  const canonical = normalizeVerdict(verdict)
  if (canonical === 'APPROVE') return blockerCount > 0
  if (canonical === 'REQUEST CHANGES') return blockerCount === 0
  return false
}

export function VerdictBanner({
  verdict,
  blockerCount,
  suggestionCount,
  shouldFixCount,
  className,
}: VerdictBannerProps) {
  const config = resolveConfig(verdict)
  const Icon = config.icon
  const mismatch = hasVerdictMismatch(verdict, blockerCount)

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 rounded-lg border p-4',
        config.bg,
        config.border,
        className,
      )}
    >
      {/* Axis 1 — the merge gate. */}
      <div className="flex items-center gap-3">
        <Icon className={cn('h-6 w-6 shrink-0', config.text)} />
        <span className={cn('text-lg font-semibold', config.text)}>
          {config.label}
        </span>
        {mismatch && (
          <span
            className="flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400"
            title="This verdict disagrees with the blocker count. It predates the directional verdict gate; the stored value is shown as-is."
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            verdict/finding mismatch
          </span>
        )}
      </div>

      {/* Axis 2 — residual work, visually subordinate to the gate. */}
      <ResidualChip
        blockerCount={blockerCount}
        shouldFixCount={shouldFixCount}
        suggestionCount={suggestionCount}
      />
    </div>
  )
}

/**
 * The residual-work chip: what is left to do, regardless of the gate. Blockers
 * (when present) read first and loudest — they are why a gate is closed.
 * Follow-ups (`should_fix`) are weighted over suggestions. When nothing remains,
 * a quiet "Clean" affordance confirms there is no outstanding work rather than
 * rendering an ambiguous row of zeros.
 */
function ResidualChip({
  blockerCount,
  shouldFixCount,
  suggestionCount,
}: {
  blockerCount?: number
  shouldFixCount?: number
  suggestionCount?: number
}) {
  const blockers = blockerCount ?? 0
  const shouldFix = shouldFixCount ?? 0
  const suggestions = suggestionCount ?? 0

  // "Clean" only when every count is both present and zero. If a count is
  // undefined we simply omit it rather than asserting cleanliness we can't know.
  const allKnown =
    blockerCount != null && shouldFixCount != null && suggestionCount != null
  if (allKnown && blockers === 0 && shouldFix === 0 && suggestions === 0) {
    return (
      <div className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-4 w-4" />
        <span className="font-medium">Clean</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-4 text-sm">
      {blockerCount != null && blockers > 0 && (
        <Stat label="Blockers" value={blockers} className="text-red-600 dark:text-red-400" />
      )}
      {shouldFixCount != null && (
        <Stat
          label="Follow-ups"
          value={shouldFix}
          className={shouldFix > 0 ? 'text-amber-600 dark:text-amber-400' : undefined}
        />
      )}
      {suggestionCount != null && (
        <Stat label="Suggestions" value={suggestions} />
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  className,
}: {
  label: string
  value: number
  className?: string
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={cn(
          'font-semibold tabular-nums',
          className ?? 'text-zinc-700 dark:text-zinc-300',
        )}
      >
        {value}
      </span>
      <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
    </div>
  )
}
