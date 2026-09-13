import { CheckIcon, ChevronDownIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { SLMProfile } from '@/types/models'

interface SLMProfileSelectorProps {
  /** Full catalog (predefined + custom); rendered as two labeled groups. */
  profiles: readonly SLMProfile[]
  /**
   * Stored active profile id. May dangle (config.yaml references a deleted or
   * unknown profile) — the trigger then shows a "not found" placeholder while
   * the surrounding banner explains the generic fallback.
   */
  activeId: string
  onSelect: (id: string) => void
  disabled?: boolean
}

/**
 * Grouped single-select for Small-LLM profiles, built on the project's Radix
 * dropdown-menu primitives (themed popup, keyboard support, zoom-corrected
 * popper positioning — see lib/floatingUiZoom). Group headers ("Predefined" /
 * "Custom") are non-interactive labels; the Custom group renders only when
 * custom profiles exist.
 */
export function SLMProfileSelector({ profiles, activeId, onSelect, disabled }: SLMProfileSelectorProps) {
  const predefined = profiles.filter((p) => p.kind === 'predefined')
  const custom = profiles.filter((p) => p.kind === 'custom')
  const active = profiles.find((p) => p.id === activeId) ?? null
  const displayLabel = active ? active.name : `Unknown profile (${activeId || 'none'})`

  const renderItem = (p: SLMProfile) => {
    const isSelected = p.id === activeId
    return (
      <DropdownMenuItem
        key={p.id}
        data-profile-id={p.id}
        data-selected={isSelected}
        className={cn('gap-2 px-3 py-1.5 text-xs', isSelected && 'bg-primary/10 font-medium')}
        onSelect={() => {
          if (p.id !== activeId) onSelect(p.id)
        }}
      >
        <span className="flex-1 text-left truncate">{p.name}</span>
        {isSelected && <CheckIcon className="size-3.5 shrink-0 text-primary" />}
      </DropdownMenuItem>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          disabled={disabled}
          aria-label="Select Small LLM profile"
          title={displayLabel}
          className={cn(
            'flex h-9 min-w-0 max-w-full items-center gap-1 rounded-md border border-input bg-background px-3 text-sm',
            'text-foreground hover:bg-muted/50 transition-colors truncate',
            'disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none',
          )}
        >
          <span className="truncate">{displayLabel}</span>
          <ChevronDownIcon className="size-4 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label="Small LLM profiles" align="start" className="min-w-72 max-h-64">
        {predefined.length > 0 && (
          <DropdownMenuLabel className="text-xs text-muted-foreground">Predefined</DropdownMenuLabel>
        )}
        {predefined.map(renderItem)}
        {custom.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">Custom</DropdownMenuLabel>
            {custom.map(renderItem)}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
