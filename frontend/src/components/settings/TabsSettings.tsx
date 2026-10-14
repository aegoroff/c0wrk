import { PanelsTopLeft } from 'lucide-react'
import { useUIStore } from '@/stores/uiStore'
import { Toggle } from './ModelProfilesControls'

/**
 * Appearance-tab control for the workspace tab bar (`uiStore.tabsEnabled`).
 * Display-level only: the tab LAYER itself is always live (stores/tabStore);
 * with the toggle off the bar is simply absent from the DOM and the layer
 * runs its documented "exactly one tab" special case — visually the pre-tab
 * UI, with the Settings gear back in the sidebar header. Off by default.
 */
export function TabsSettings() {
  const enabled = useUIStore((s) => s.tabsEnabled)
  const setEnabled = useUIStore((s) => s.setTabsEnabled)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <PanelsTopLeft className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Tabs</span>
      </div>
      <Toggle
        checked={enabled}
        onChange={setEnabled}
        label={enabled ? 'Enabled' : 'Disabled'}
        description="Show the workspace tab bar above the chat. Tabs remember their project, session and panel layout; with the bar hidden the app behaves as a single-tab workspace."
      />
    </div>
  )
}
