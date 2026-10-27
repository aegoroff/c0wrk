import { useCallback, useEffect, useRef, useState } from 'react'
import { updateSearchSettings } from '@/api/config'
import { logger } from '@/lib/logger'

export interface SearchConfig {
  provider: string
  api_key: string
  base_url: string
}

/**
 * Debounced full-config save for the web-search provider section. Every
 * COMMITTED edit flows through `debouncedSave` (500 ms); a pending
 * committed edit is FLUSHED on unmount (closing the settings dialog /
 * switching tabs) instead of being silently discarded.
 */
export function useSearchProviderSave() {
  const [saveError, setSaveError] = useState<string | null>(null)
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const pendingConfigRef = useRef<SearchConfig | null>(null)

  const saveSettings = useCallback(async (newConfig: SearchConfig) => {
    try {
      await updateSearchSettings({
        provider: newConfig.provider,
        api_key: newConfig.api_key,
        base_url: newConfig.base_url,
      })
      setSaveError(null)
    } catch (err) {
      logger.error('Failed to save search settings:', err)
      setSaveError(err instanceof Error ? err.message : 'Failed to save search settings')
    }
  }, [])

  const debouncedSave = useCallback(
    (newConfig: SearchConfig) => {
      pendingConfigRef.current = newConfig
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = setTimeout(() => {
        saveTimeoutRef.current = null
        pendingConfigRef.current = null
        void saveSettings(newConfig)
      }, 500)
    },
    [saveSettings],
  )

  // Flush a pending debounced save on unmount so a user who edits the search
  // provider / API key and closes the modal (or switches tabs) within the
  // debounce window does not lose the change. Safe against half-typed keys:
  // pendingConfigRef only ever holds COMMITTED values (a key edit enters the
  // save flow on blur/Enter, never per keystroke), so the flush cannot
  // persist an unfinished fragment over the stored key.
  useEffect(
    () => () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
        saveTimeoutRef.current = null
      }
      const pending = pendingConfigRef.current
      pendingConfigRef.current = null
      if (pending) void saveSettings(pending)
    },
    [saveSettings],
  )

  return { saveError, debouncedSave }
}
