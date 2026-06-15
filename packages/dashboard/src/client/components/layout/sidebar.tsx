import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Home, GitBranch, FileSearch, Terminal, Users } from 'lucide-react'
import { cn } from '../../lib/utils'
import { OcrLogoIcon } from '../ocr-logo'
import { useSocket } from '../../providers/socket-provider'
import { useCommandState } from '../../providers/command-state-provider'
import { useIdeConfig } from '../../hooks/use-ide-config'

const NAV_ITEMS = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/commands', label: 'Commands', icon: Terminal },
  { to: '/reviewers', label: 'Team', icon: Users },
  { to: '/sessions', label: 'Sessions', icon: GitBranch },
  { to: '/reviews', label: 'Reviews', icon: FileSearch },
] as const

const STATUS_COLORS: Record<string, string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-500 animate-pulse',
  reconnecting: 'bg-amber-500 animate-pulse',
  disconnected: 'bg-red-500',
}

export function Sidebar() {
  const location = useLocation()
  const { status } = useSocket()
  const { runningCount } = useCommandState()
  const { data: config } = useIdeConfig()

  useEffect(() => {
    if (config?.workspaceName) {
      const branch = config.gitBranch ? ` (${config.gitBranch})` : ''
      document.title = `${config.workspaceName}${branch} — OCR Dashboard`
    } else {
      document.title = 'OCR Dashboard'
    }
  }, [config?.workspaceName, config?.gitBranch])

  return (
    <aside className="flex h-full w-56 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="group/brand relative flex h-14 items-center gap-2.5 border-b border-zinc-200 px-4 dark:border-zinc-800">
        <OcrLogoIcon className="h-6 w-auto shrink-0 text-zinc-900 dark:text-zinc-100" />
        <div className="min-w-0 flex-1">
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            OCR Dashboard
          </span>
          {config?.workspaceName && (
            <span className="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">
              {config.workspaceName}
              {config.gitBranch && (
                <span className="ml-1 text-zinc-400 dark:text-zinc-500">
                  ({config.gitBranch})
                </span>
              )}
            </span>
          )}
        </div>

        {/* Hover tooltip with full workspace details */}
        {config?.workspaceName && (
          <div className="pointer-events-none absolute left-full top-2 z-50 ml-2 min-w-[280px] max-w-sm opacity-0 transition-opacity delay-300 group-hover/brand:opacity-100">
            {/* Arrow */}
            <div className="absolute -left-1 top-3 h-2 w-2 rotate-45 bg-zinc-900 dark:bg-zinc-700" />
            {/* Content */}
            <div className="relative rounded-lg bg-zinc-900 px-3 py-2 text-xs shadow-lg dark:bg-zinc-700">
              <div className="font-medium text-white">{config.workspaceName}</div>
              {config.gitBranch && (
                <div className="mt-0.5 font-mono text-emerald-400">
                  {config.gitBranch}
                </div>
              )}
              <div className="mt-1.5 break-words border-t border-zinc-700 pt-1.5 font-mono text-[10px] text-zinc-400 dark:border-zinc-600">
                {config.projectRoot}
              </div>
            </div>
          </div>
        )}
      </div>

      <nav className="flex-1 space-y-1 p-2">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => {
          const active =
            to === '/' ? location.pathname === '/' : location.pathname.startsWith(to)
          return (
            <Link
              key={to}
              to={to}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                active
                  ? 'bg-zinc-200 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                  : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100',
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
              {to === '/commands' && runningCount > 0 && (
                <span className="ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-indigo-500 px-1.5 text-[10px] font-semibold text-white">
                  {runningCount}
                </span>
              )}
            </Link>
          )
        })}
      </nav>

      <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
        <div
          role="status"
          aria-label={`Connection status: ${status}`}
          className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400"
        >
          <div
            className={cn('h-2 w-2 rounded-full', STATUS_COLORS[status])}
            aria-hidden="true"
          />
          <span className="capitalize">{status}</span>
        </div>
      </div>
    </aside>
  )
}
