# ADR-090: Sidebar Settings Gear Is Unconditional

## Status

Accepted — amends [ADR-085](./085-workspace-tabs-single-engine.md)

## Context

ADR-085's decision 1 enumerated the `tabsEnabled` flag's display scope as "the tab bar's rendering (and, with it, the sidebar Settings gear, which the bar replaces when shown)" — a one-settings-entry-point handoff: with the tab bar on, the sidebar header dropped its gear and the strip carried the Settings affordance at its right edge. Living with it showed the handoff costs more than it buys: the gear leaves the sidebar header where it has always lived (the position users know regardless of the flag), and the right edge of a workspace tab strip is a non-obvious place to look for app-wide settings — the strip reads as tab-scoped chrome, so a global affordance there is easy to miss and easy to mistake for tab-scoped.

## Decision

The sidebar header's Settings gear is unconditional: `frontend/src/components/layout/SidebarHeader.tsx` renders the gear in BOTH `tabsEnabled` states (opening Settings on the default tab, exactly as before tabs), and `frontend/src/components/layout/TabBar.tsx` carries no Settings button. The flag's gate narrows to what remains: the tab bar's rendering (`AppLayout`), the tab-cycling hotkeys' flag early-return (`useTabHotkeys` — with the flag off the cycling combos stay inert, an affordance of the visible bar), and the notification-click routing branch (`useNotificationClicks`). This narrows ADR-085 decision 1's enumeration — the parenthetical gear handoff no longer applies; every other ADR-085 decision (always-live tab layer, single activation engine, snapshot slices, per-project file viewer) is unchanged and untouched.

## Consequences

Positive: Settings stays in one place regardless of the tab mode; the tab strip keeps only tab-scoped affordances («+», close); one fewer flag-driven render branch in the shell.

Negative: the "exactly one Settings entry point" symmetry argument from ADR-085 is dropped — the cost is a static duplicate-free header, not a functional one, since the strip simply no longer duplicates the affordance.

Tests: `SidebarHeader.test.tsx` asserts the gear in both flag states and the default-tab open; the former TabBar Settings-button test was removed with the button.

## Alternatives Considered

- Keep the handoff, restyle the strip's Settings affordance as an overflow/kebab menu — rejected: hides Settings further and still leaves the header gearless with tabs on.
- Edit ADR-085 in place — rejected: Accepted ADRs are immutable (META.md); the scope narrowing is recorded by this ADR instead.
