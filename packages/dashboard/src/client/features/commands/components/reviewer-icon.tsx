import {
  Activity,
  Blocks,
  Bot,
  Layers,
  Compass,
  Layout,
  Server,
  Cloud,
  Gauge,
  Accessibility,
  Database,
  Rocket,
  Terminal,
  Smartphone,
  Crown,
  Sparkles,
  ShieldAlert,
  TestTubes,
  Brain,
  User,
  FileText,
  type LucideIcon,
} from 'lucide-react'

// Exported so a contract test can assert every BUILTIN_ICON_MAP value (the icon
// strings the CLI writes) resolves to a real glyph here — see issue #28 Medium-2.
export const ICON_MAP: Record<string, LucideIcon> = {
  activity: Activity,
  blocks: Blocks,
  bot: Bot,
  layers: Layers,
  compass: Compass,
  layout: Layout,
  server: Server,
  cloud: Cloud,
  gauge: Gauge,
  accessibility: Accessibility,
  database: Database,
  rocket: Rocket,
  terminal: Terminal,
  smartphone: Smartphone,
  crown: Crown,
  sparkles: Sparkles,
  'shield-alert': ShieldAlert,
  'test-tubes': TestTubes,
  'file-text': FileText,
  brain: Brain,
  user: User,
}

type ReviewerIconProps = {
  icon: string
  className?: string
}

export function ReviewerIcon({ icon, className = 'h-4 w-4' }: ReviewerIconProps) {
  const Icon = ICON_MAP[icon] ?? User
  return <Icon className={className} />
}
