import { Handshake, Swords, Link2, Lightbulb, MessageCircle } from 'lucide-react'
import { cn } from '../../lib/utils'
import { MarkdownRenderer } from './markdown-renderer'

type DiscourseType = 'AGREE' | 'CHALLENGE' | 'CONNECT' | 'SURFACE'

type DiscourseConfig = {
  icon: typeof Handshake
  borderColor: string
  bgColor: string
  label: string
}

type DiscourseBlockProps = {
  /** Normally one of the four known types, but kept as a free string so an
   *  unexpected value (legacy artifact, parser change) degrades to a neutral
   *  block rather than crashing the whole review report. */
  type: DiscourseType | string
  content: string
  reviewer?: string
  className?: string
}

const DISCOURSE_CONFIG: Record<DiscourseType, DiscourseConfig> = {
  AGREE: {
    icon: Handshake,
    borderColor: 'border-l-emerald-500',
    bgColor: 'bg-emerald-500/5',
    label: 'Agree',
  },
  CHALLENGE: {
    icon: Swords,
    borderColor: 'border-l-red-500',
    bgColor: 'bg-red-500/5',
    label: 'Challenge',
  },
  CONNECT: {
    icon: Link2,
    borderColor: 'border-l-blue-500',
    bgColor: 'bg-blue-500/5',
    label: 'Connect',
  },
  SURFACE: {
    icon: Lightbulb,
    borderColor: 'border-l-amber-500',
    bgColor: 'bg-amber-500/5',
    label: 'Surface',
  },
}

/**
 * Neutral fallback for an unrecognized discourse type. Mirrors the tolerance
 * `verdict-banner.tsx` already applies to unknown verdicts: render the raw
 * type as the label rather than throwing on `config.icon` of `undefined`.
 */
const UNKNOWN_DISCOURSE_CONFIG: DiscourseConfig = {
  icon: MessageCircle,
  borderColor: 'border-l-zinc-400',
  bgColor: 'bg-zinc-500/5',
  label: 'Discourse',
}

export function resolveDiscourseConfig(type: string): DiscourseConfig {
  const known = DISCOURSE_CONFIG[type as DiscourseType]
  if (known) return known
  const label = type.trim()
  return { ...UNKNOWN_DISCOURSE_CONFIG, label: label || UNKNOWN_DISCOURSE_CONFIG.label }
}

export function DiscourseBlock({ type, content, reviewer, className }: DiscourseBlockProps) {
  const config = resolveDiscourseConfig(type)
  const Icon = config.icon

  return (
    <div
      className={cn(
        'rounded-r-lg border-l-4 p-4',
        config.borderColor,
        config.bgColor,
        className,
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <Icon className="h-4 w-4 text-zinc-600 dark:text-zinc-400" />
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {config.label}
        </span>
        {reviewer && (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            — {reviewer}
          </span>
        )}
      </div>
      <MarkdownRenderer content={content} />
    </div>
  )
}

type DiscourseSection = {
  type: DiscourseType
  reviewer?: string
  content: string
}

export function parseDiscourseContent(markdown: string): DiscourseSection[] {
  const sections: DiscourseSection[] = []
  const pattern = /^###?\s+(AGREE|CHALLENGE|CONNECT|SURFACE)(?:\s*[-—]\s*(.+))?$/gm

  let match: RegExpExecArray | null
  let lastIndex = 0
  let lastSection: DiscourseSection | null = null

  while ((match = pattern.exec(markdown)) !== null) {
    if (lastSection) {
      lastSection.content = markdown.slice(lastIndex, match.index).trim()
      sections.push(lastSection)
    }
    lastSection = {
      type: match[1] as DiscourseType,
      reviewer: match[2]?.trim(),
      content: '',
    }
    lastIndex = match.index + match[0].length
  }

  if (lastSection) {
    lastSection.content = markdown.slice(lastIndex).trim()
    sections.push(lastSection)
  }

  return sections
}
