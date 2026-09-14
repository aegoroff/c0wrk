// ThemeSelector menu row — a dropdown item for a single theme (builtin or
// custom), extracted from ThemeSelector.tsx to keep both files under the
// 200-line component budget. Builtin rows render icon + name + check;
// custom rows add the shared hover ItemActions overlay with a one-click
// delete (the same pattern as session/project rows).
//
// Radix note: the ItemActions overlay stops pointerdown/pointerup/click
// propagation, so a trash click never reaches the DropdownMenuItem — the
// item is not selected and the menu stays open while the list refreshes.

import { Check, Moon, Sun, Trash2 } from 'lucide-react'

import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { ItemAction, ItemActions } from '@/components/layout/ItemAction'
import { cn } from '@/lib/utils'
import { themeTypeOf } from '@/stores/themeStore'

/** A theme row as rendered in the menu — structural type so both builtin
 *  descriptors and backend ThemeInfo entries (type is a plain string there)
 *  flow through without normalization. */
export interface ThemeRow {
  id: string
  name: string
  type: string
}

interface ThemeMenuItemProps {
  theme: ThemeRow
  active: boolean
  onSelect: (id: string) => void
  /** Present on custom themes only — renders the hover-delete overlay. */
  onDelete?: (id: string) => void
}

/** Type icon for a theme kind — shared by rows and the trigger. */
export function ThemeTypeIcon({ type, className }: { type: string; className?: string }) {
  const Icon = themeTypeOf({ type }) === 'light' ? Sun : Moon
  return <Icon className={cn('size-3.5 shrink-0', className)} />
}

export function ThemeMenuItem({ theme, active, onSelect, onDelete }: ThemeMenuItemProps) {
  return (
    <DropdownMenuItem
      data-selected={active}
      className={cn('group/item gap-2', active && 'bg-primary/10 font-medium')}
      onSelect={() => onSelect(theme.id)}
    >
      <ThemeTypeIcon type={theme.type} />
      <span className="min-w-0 flex-1 truncate text-left">{theme.name}</span>
      {active && <Check className="size-3.5 shrink-0 text-primary" />}
      {onDelete && (
        <ItemActions>
          <ItemAction label="Delete theme" onClick={() => onDelete(theme.id)}>
            <Trash2 className="size-3 text-destructive" />
          </ItemAction>
        </ItemActions>
      )}
    </DropdownMenuItem>
  )
}
