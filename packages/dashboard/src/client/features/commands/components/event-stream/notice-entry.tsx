/**
 * Notice entry — a runner-originated operational notice (NOT agent output).
 *
 * Surfaces conditions the command-runner itself raises: a per-instance model
 * dropped because the adapter lacks per-subagent support, or a run
 * force-finalized at the hard deadline. Styled distinctly from agent errors —
 * amber for `warning`, slate/blue for `info` — so the user can tell a runner
 * notice from an agent-raised error at a glance.
 */

import { Info, AlertTriangle } from 'lucide-react'
import { cn } from '../../../../lib/utils'

type NoticeEntryProps = {
  level: 'info' | 'warning'
  message: string
}

export function NoticeEntry({ level, message }: NoticeEntryProps) {
  const isWarning = level === 'warning'
  const Icon = isWarning ? AlertTriangle : Info
  return (
    <div
      className={cn(
        'my-1 rounded-md border px-3 py-2',
        isWarning
          ? 'border-amber-300 bg-amber-50 dark:border-amber-800/60 dark:bg-amber-950/30'
          : 'border-sky-300 bg-sky-50 dark:border-sky-800/60 dark:bg-sky-950/30',
      )}
    >
      <div className="flex items-start gap-2">
        <Icon
          aria-hidden
          className={cn(
            'mt-0.5 h-4 w-4 shrink-0',
            isWarning
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-sky-600 dark:text-sky-400',
          )}
        />
        <div className="min-w-0 flex-1">
          <span
            className={cn(
              'text-[10px] font-medium uppercase tracking-wider',
              isWarning
                ? 'text-amber-700 dark:text-amber-400'
                : 'text-sky-700 dark:text-sky-400',
            )}
          >
            {isWarning ? 'Warning' : 'Notice'}
          </span>
          <p
            className={cn(
              'mt-1 whitespace-pre-wrap break-words text-[13px] font-medium',
              isWarning
                ? 'text-amber-800 dark:text-amber-200'
                : 'text-sky-800 dark:text-sky-200',
            )}
          >
            {message}
          </p>
        </div>
      </div>
    </div>
  )
}
