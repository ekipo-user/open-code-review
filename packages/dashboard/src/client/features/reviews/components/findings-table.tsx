import { useMemo, useState } from 'react'
import { Filter } from 'lucide-react'
import type { Finding, FindingSeverity, FindingTriage } from '../../../lib/api-types'
import { useUpdateFindingStatus } from '../hooks/use-reviews'
import { FindingRow } from './finding-row'
import { SortableHeader } from '../../../components/ui/sortable-header'

type SortField = 'severity' | 'title' | 'file_path'
type SortDir = 'asc' | 'desc'

const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
}

/**
 * Rank a finding's severity for sorting. An unrecognized severity (a degraded
 * row from a malformed or future-schema finding) sorts deterministically last
 * instead of producing `NaN` — which would make the comparator return `NaN` and
 * leave the table in an arbitrary, unstable order.
 */
const UNKNOWN_SEVERITY_RANK = Number.MAX_SAFE_INTEGER
function severityRank(severity: string): number {
  return SEVERITY_ORDER[severity as FindingSeverity] ?? UNKNOWN_SEVERITY_RANK
}

const SEVERITY_FILTER_OPTIONS: { value: FindingSeverity | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'info', label: 'Info' },
]

const TRIAGE_FILTER_OPTIONS: { value: FindingTriage | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'read', label: 'Read' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'wont_fix', label: "Won't Fix" },
]

type FindingsTableProps = {
  findings: Finding[]
  /** While the findings query is in flight, render a loading affordance instead
   *  of an ambiguous "no findings" empty state. */
  isLoading?: boolean
}

export function FindingsTable({ findings, isLoading = false }: FindingsTableProps) {
  const [sortField, setSortField] = useState<SortField>('severity')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [severityFilter, setSeverityFilter] = useState<FindingSeverity | 'all'>('all')
  const [triageFilter, setTriageFilter] = useState<FindingTriage | 'all'>('all')

  const updateStatus = useUpdateFindingStatus()

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir('asc')
    }
  }

  const filtered = useMemo(() => {
    let result = findings
    if (severityFilter !== 'all') {
      result = result.filter((f) => f.severity === severityFilter)
    }
    if (triageFilter !== 'all') {
      result = result.filter((f) => {
        const status = f.progress?.status ?? 'unread'
        return status === triageFilter
      })
    }
    return result
  }, [findings, severityFilter, triageFilter])

  const sorted = useMemo(() => {
    const multiplier = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      if (sortField === 'severity') {
        return (severityRank(a.severity) - severityRank(b.severity)) * multiplier
      }
      if (sortField === 'title') {
        return a.title.localeCompare(b.title) * multiplier
      }
      if (sortField === 'file_path') {
        return (a.file_path ?? '').localeCompare(b.file_path ?? '') * multiplier
      }
      return 0
    })
  }, [filtered, sortField, sortDir])

  // A finding whose severity isn't in the known vocabulary is a degraded row —
  // surface it so an unrecognized severity reads as "sorted last" rather than a
  // silent ordering glitch.
  const degradedCount = useMemo(
    () => findings.filter((f) => !(f.severity in SEVERITY_ORDER)).length,
    [findings],
  )

  function handleTriageChange(findingId: number, status: FindingTriage) {
    updateStatus.mutate({ findingId, status })
  }

  // Loading: the query is still in flight. Distinct from a genuinely empty round.
  if (isLoading) {
    return (
      <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
        Loading findings…
      </p>
    )
  }

  // Genuinely empty: the round completed with no findings recorded. This is a
  // legitimate, often-good outcome (a clean APPROVE), not a filter mismatch.
  if (findings.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
        No findings were recorded for this round.
      </p>
    )
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Filter className="h-4 w-4 text-zinc-400" />
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Severity:</span>
          <select
            value={severityFilter}
            onChange={(e) =>
              setSeverityFilter(e.target.value as FindingSeverity | 'all')
            }
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          >
            {SEVERITY_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 dark:text-zinc-400">Status:</span>
          <select
            value={triageFilter}
            onChange={(e) =>
              setTriageFilter(e.target.value as FindingTriage | 'all')
            }
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          >
            {TRIAGE_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <span className="text-xs text-zinc-400 dark:text-zinc-500">
          {sorted.length} of {findings.length} findings
        </span>
      </div>

      {degradedCount > 0 && (
        <p className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {degradedCount} finding{degradedCount === 1 ? '' : 's'} have an
          unrecognized severity and are sorted last.
        </p>
      )}

      {sorted.length === 0 ? (
        <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
          No findings match your filters.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900">
              <tr>
                <SortableHeader
                  label="Severity"
                  field="severity"
                  activeField={sortField}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <SortableHeader
                  label="Title"
                  field="title"
                  activeField={sortField}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <SortableHeader
                  label="File"
                  field="file_path"
                  activeField={sortField}
                  direction={sortDir}
                  onSort={handleSort}
                />
                <th className="border-b border-zinc-200 px-4 py-2 text-left font-medium text-zinc-900 dark:border-zinc-800 dark:text-zinc-100">
                  Lines
                </th>
                <th className="border-b border-zinc-200 px-4 py-2 text-left font-medium text-zinc-900 dark:border-zinc-800 dark:text-zinc-100">
                  Blocker
                </th>
                <th className="border-b border-zinc-200 px-4 py-2 text-left font-medium text-zinc-900 dark:border-zinc-800 dark:text-zinc-100">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((finding) => (
                <FindingRow
                  key={finding.id}
                  finding={finding}
                  onTriageChange={handleTriageChange}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
