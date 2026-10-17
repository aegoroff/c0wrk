import { useCallback, useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { getConfig } from '@/api/config'
import { setPromptSuggestionsEnabled } from '@/api/suggestions'
import { logger } from '@/lib/logger'
import { Toggle } from './ModelProfilesControls'

/**
 * General-tab control for the prompt-suggestions master gate (ADR-088),
 * mirroring ExperimentalSettings above it. The gate decides whether the
 * backend generates follow-up prompt suggestions at all (session-scoped
 * `prompt_suggestions` event + the chat input's ↑/↓/→ suggestion mode);
 * disabling it never touches the chat path itself — the subsystem is
 * fail-open and its absence is silent.
 *
 * The value lives in backend config (nil default = on), so the section reads
 * the effective gate through GetConfig on mount and writes through
 * SetPromptSuggestionsEnabled — which persists AND applies in the same call
 * (the manager's outcome gate flips without a restart). Writes are optimistic
 * with a rollback: the backend's persisted-and-applied contract means a
 * rejected write leaves the previous value authoritative everywhere, so the
 * control snaps back to it.
 */
export function PromptSuggestionsSettings() {
  // null until the config answers — the toggle stays disabled rather than
  // showing a guessed state.
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getConfig()
      .then((cfg) => {
        if (!cancelled) setEnabled(cfg.prompt_suggestions?.enabled ?? true)
      })
      .catch((err) => logger.warn('[prompt-suggestions] gate read failed', err))
    return () => {
      cancelled = true
    }
  }, [])

  const handleChange = useCallback(
    async (next: boolean) => {
      if (enabled === null) return
      const previous = enabled
      setEnabled(next) // optimistic: the control must feel immediate
      setSaving(true)
      try {
        await setPromptSuggestionsEnabled(next)
      } catch (err) {
        logger.error('Failed to toggle prompt suggestions:', err)
        setEnabled(previous) // the backend still holds the previous value
      } finally {
        setSaving(false)
      }
    },
    [enabled],
  )

  return (
    <div className="flex flex-col gap-2" data-testid="prompt-suggestions-settings">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Prompt Suggestions</span>
      </div>
      <Toggle
        checked={enabled ?? false}
        onChange={(next) => void handleChange(next)}
        disabled={enabled === null || saving}
        label={enabled === false ? 'Disabled' : 'Enabled'}
        description="Suggest follow-up prompts in the chat input after a task finishes (navigate with ↑/↓, insert with →). When disabled, no suggestions are generated; the change applies immediately."
      />
    </div>
  )
}
