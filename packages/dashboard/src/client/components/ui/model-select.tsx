import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, List } from 'lucide-react'
import { cn } from '../../lib/utils'

export type ModelSelectOption = {
  /** The selected value passed to onChange. Empty string is the synthetic "(default)" option. */
  id: string
  /** Primary label (typically a friendly name, e.g. "Claude Opus 4.7"). */
  label: string
  /** Secondary label rendered in muted mono — typically the raw model id. */
  detail?: string
}

/**
 * Internal sentinel for the "Custom…" entry. Intercepted before `onChange`
 * — it can never leak into team state. The NUL prefix makes an accidental
 * collision with a real model id impossible.
 */
const CUSTOM_OPTION_ID = '\u0000custom'

type ModelSelectProps = {
  value: string
  options: ModelSelectOption[]
  onChange: (next: string) => void
  /**
   * When true, render a free-text input instead of the dropdown.
   * Used when the active AI CLI didn't return a model list — the user
   * types whatever model id their CLI accepts.
   */
  freeText?: boolean
  freeTextPlaceholder?: string
  disabled?: boolean
  className?: string
  /**
   * Offer a "Custom…" entry that switches the picker to free-text input.
   * Opt-in: enable it on MODEL pickers (listed models are advisory — any id
   * the vendor CLI accepts is valid, issue #39's escape hatch), and leave it
   * off for non-model uses of this component (e.g. the Add-reviewer picker),
   * where free-text input is meaningless.
   */
  allowCustom?: boolean
  /**
   * Optional aria-label for the trigger button. Use when the visible label
   * isn't sufficient context for screen readers.
   */
  ariaLabel?: string
  /** Open the listbox on mount. Used by transient pickers like AddReviewerCard. */
  defaultOpen?: boolean
  /** Notified whenever the listbox opens or closes — lets parents drive cancel-on-close flows. */
  onOpenChange?: (open: boolean) => void
}

/**
 * Custom model picker that matches the dashboard's design system —
 * replaces the native `<select>` for the team-config + reviewer-dialog
 * surfaces. Two-row option rendering so we can show friendly name + raw
 * model id together.
 *
 * A value not present in `options` (e.g. a saved team referencing a model
 * id that is no longer listed) renders as a selectable "(custom)" option —
 * never as a blank trigger or a silent fall-back to the first option.
 *
 * No portal, no popper, no third-party dependency — the dropdown is
 * absolutely positioned within a relative wrapper. The component owns
 * its own click-outside, ESC, and arrow-key navigation.
 */
export function ModelSelect({
  value,
  options,
  onChange,
  freeText = false,
  freeTextPlaceholder = 'Type model id…',
  disabled = false,
  className,
  allowCustom = false,
  ariaLabel,
  defaultOpen = false,
  onOpenChange,
}: ModelSelectProps) {
  const [open, setOpenState] = useState(defaultOpen)
  // User clicked "Custom…" — show the free-text input with a way back.
  const [customMode, setCustomMode] = useState(false)
  // Index of the keyboard-highlighted item (for arrow-key navigation).
  // -1 = none highlighted; on open we sync to the selected option's index.
  const [highlight, setHighlight] = useState(-1)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const customInputRef = useRef<HTMLInputElement>(null)
  const listboxId = useId()

  const setOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    setOpenState((prev) => {
      const value = typeof next === 'function' ? next(prev) : next
      if (value !== prev) onOpenChange?.(value)
      return value
    })
  }

  // Unknown non-empty values surface as a real option so the saved id stays
  // visible and re-selectable instead of rendering blank.
  const isKnown = options.some((o) => o.id === value)
  const listOptions: ModelSelectOption[] = [
    ...(value && !isKnown
      ? [{ id: value, label: value, detail: '(custom)' }]
      : []),
    ...options,
    ...(allowCustom && !freeText
      ? [{ id: CUSTOM_OPTION_ID, label: 'Custom…', detail: 'type any model id' }]
      : []),
  ]

  const showFreeText = freeText || customMode

  // Click-outside close
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!wrapperRef.current) return
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // ESC close
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  const selected = listOptions.find((o) => o.id === value) ?? listOptions[0] ?? null
  const selectedIndex = selected
    ? listOptions.findIndex((o) => o.id === selected.id)
    : -1

  // Sync highlight to the currently selected option whenever the menu opens
  useEffect(() => {
    if (open) setHighlight(selectedIndex >= 0 ? selectedIndex : 0)
  }, [open, selectedIndex])

  // Focus the free-text input when entering custom mode.
  useEffect(() => {
    if (customMode) customInputRef.current?.focus()
  }, [customMode])

  function selectOption(opt: ModelSelectOption): void {
    if (opt.id === CUSTOM_OPTION_ID) {
      setOpen(false)
      setCustomMode(true)
      return
    }
    onChange(opt.id)
    setOpen(false)
    triggerRef.current?.focus()
  }

  function handleTriggerKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setOpen(true)
    }
  }

  function handleListKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(listOptions.length - 1, (h < 0 ? -1 : h) + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(0, (h < 0 ? listOptions.length : h) - 1))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setHighlight(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setHighlight(listOptions.length - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (highlight >= 0 && highlight < listOptions.length) {
        const opt = listOptions[highlight]
        if (opt) selectOption(opt)
      }
    } else if (e.key === 'Tab') {
      // Let Tab close and move focus naturally
      setOpen(false)
    }
  }

  if (showFreeText) {
    return (
      <div className={cn('flex items-center gap-1', className)}>
        <input
          ref={customInputRef}
          type="text"
          value={value}
          placeholder={freeTextPlaceholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Keyboard path back to the list (mirrors the back button).
            if (e.key === 'Escape' && customMode) {
              e.preventDefault()
              setCustomMode(false)
            }
          }}
          aria-label={ariaLabel}
          className={cn(
            'w-full min-w-0 flex-1 rounded-md border bg-white px-2.5 py-1.5 font-mono text-xs',
            'border-zinc-200 text-zinc-700 placeholder:text-zinc-400',
            'focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400/50',
            'dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:placeholder:text-zinc-500',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        />
        {customMode && (
          <button
            type="button"
            onClick={() => setCustomMode(false)}
            aria-label="Back to model list"
            title="Back to model list"
            className={cn(
              'shrink-0 rounded-md border p-1.5 text-zinc-500 transition',
              'border-zinc-200 hover:bg-zinc-50 hover:text-zinc-700',
              'dark:border-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300',
            )}
          >
            <List className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>
    )
  }

  const triggerLabel = selected?.label ?? freeTextPlaceholder
  const triggerDetail = selected?.detail

  return (
    <div ref={wrapperRef} className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={handleTriggerKeyDown}
        className={cn(
          'flex w-full items-center gap-2 rounded-md border bg-white px-2.5 py-1.5 text-left',
          'border-zinc-200 hover:border-zinc-300',
          'focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400/50',
          'dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-600',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-700 dark:text-zinc-300">
          {triggerLabel}
        </span>
        {triggerDetail && (
          <span className="hidden shrink-0 truncate font-mono text-[10px] text-zinc-400 dark:text-zinc-500 sm:block">
            {triggerDetail}
          </span>
        )}
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform dark:text-zinc-500',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          onKeyDown={handleListKeyDown}
          aria-activedescendant={
            highlight >= 0 ? `${listboxId}-opt-${highlight}` : undefined
          }
          ref={(el) => {
            // Auto-focus the listbox when it mounts so arrow keys work
            // immediately without an extra click.
            el?.focus()
          }}
          className={cn(
            'absolute left-0 right-0 z-30 mt-1 max-h-64 overflow-auto rounded-md border bg-white py-1 shadow-lg outline-none',
            'border-zinc-200 dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-black/30',
          )}
        >
          {listOptions.length === 0 ? (
            <div className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
              No models available.
            </div>
          ) : (
            listOptions.map((opt, idx) => {
              const isSelected = opt.id === value
              const isHighlighted = idx === highlight
              return (
                <button
                  key={opt.id || `__default-${idx}`}
                  id={`${listboxId}-opt-${idx}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => selectOption(opt)}
                  onMouseEnter={() => setHighlight(idx)}
                  className={cn(
                    'flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors',
                    isHighlighted
                      ? 'bg-zinc-100 dark:bg-zinc-800'
                      : 'bg-transparent',
                    isSelected && 'bg-indigo-50/60 dark:bg-indigo-950/40',
                  )}
                >
                  <Check
                    className={cn(
                      'mt-0.5 h-3.5 w-3.5 shrink-0',
                      isSelected
                        ? 'text-indigo-600 dark:text-indigo-400'
                        : 'text-transparent',
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">
                      {opt.label}
                    </span>
                    {opt.detail && (
                      <span className="block truncate font-mono text-[10px] text-zinc-500 dark:text-zinc-500">
                        {opt.detail}
                      </span>
                    )}
                  </span>
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
