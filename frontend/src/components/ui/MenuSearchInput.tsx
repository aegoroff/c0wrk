import * as React from "react"
import { Input } from "@/components/ui/input"

/**
 * Search input for use INSIDE a Radix dropdown menu's content
 * (SessionSelectorToolbar, BranchDropdown).
 *
 * `@radix-ui/react-menu` runs its typeahead for EVERY printable character
 * pressed anywhere inside the content — the installed version has no
 * input-target exclusion — and focuses the first menu item whose text
 * matches. The search field's first real keystroke used to blur the input
 * that way (SessionSelector: the session rows and "New Session..." are real
 * `DropdownMenuItem`s). The typeahead accumulates keystrokes in a ref and
 * resets it after 1s, which is why only the first character (and any later
 * run that still prefix-matches an item) stole focus.
 *
 * The guard stops the propagation of exactly the keys the typeahead acts on —
 * Radix's own `!ctrl && !alt && !meta && key.length === 1` condition — so
 * Escape/Tab/arrows/Enter/modifier combos keep reaching the menu and its
 * document-level listeners untouched.
 */
export function MenuSearchInput({ onKeyDown, ...props }: React.ComponentProps<typeof Input>) {
  const guardedKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (!event.ctrlKey && !event.altKey && !event.metaKey && event.key.length === 1) {
        // Keep the menu's typeahead from seeing (and acting on) this key.
        event.stopPropagation()
      }
      onKeyDown?.(event)
    },
    [onKeyDown],
  )
  return <Input {...props} onKeyDown={guardedKeyDown} />
}
