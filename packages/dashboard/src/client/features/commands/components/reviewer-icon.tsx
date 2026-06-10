import {
  Activity,
  Blocks,
  Bot,
  Layers,
  ShieldCheck,
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

const ICON_MAP: Record<string, LucideIcon> = {
  activity: Activity,
  blocks: Blocks,
  bot: Bot,
  layers: Layers,
  'shield-check': ShieldCheck,
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
