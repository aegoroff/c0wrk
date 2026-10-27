import { useState, useEffect } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Globe } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Combobox } from '@/components/ui/combobox'
import { getConfig, MASKED_API_KEY } from '@/api/config'
import { logger } from '@/lib/logger'
import { useSearchProviderSave, type SearchConfig } from './useSearchProviderSave'
import { SearchProviderNotices } from './SearchProviderNotices'

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  tavily: 'Tavily',
  brave: 'Brave Search',
  exa: 'Exa AI',
  duckduckgo: 'DuckDuckGo',
  searxng: 'SearXNG (self-hosted)',
}

const PROVIDER_KEYS = ['tavily', 'brave', 'exa', 'duckduckgo', 'searxng']
const NO_API_KEY_PROVIDERS = ['duckduckgo', 'searxng']

/** Backend default for the SearXNG instance URL (mirrors config.ApplyDefaults). */
const SEARXNG_DEFAULT_BASE_URL = 'http://127.0.0.1:8888'

/**
 * The web-search provider section of the Search tab: provider picker, API
 * key, and the SearXNG instance URL. The API-key and instance-URL fields
 * are explicit-commit fields (blur/Enter) feeding a 500 ms debounced save —
 * see useSearchProviderSave for the flush contract.
 */
export function WebSearchProviderSettings() {
  const [config, setConfig] = useState<SearchConfig>({ provider: 'tavily', api_key: '', base_url: '' })
  const [isLoading, setIsLoading] = useState(true)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [isApiKeyFocused, setIsApiKeyFocused] = useState(false)
  const [baseUrlInput, setBaseUrlInput] = useState('')
  const { saveError, debouncedSave } = useSearchProviderSave()

  useEffect(() => {
    const load = async () => {
      try {
        const result = await getConfig()
        if (result?.search) {
          setConfig(result.search)
          setApiKeyInput(result.search.api_key === MASKED_API_KEY ? '' : result.search.api_key)
          setBaseUrlInput(result.search.base_url ?? '')
        }
      } catch (err) {
        logger.error('Failed to load search config:', err)
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [])

  // commitApiKeyDraft moves an API-key edit from the local input draft into
  // the saved config. Keystrokes NEVER schedule a save: the stored key is
  // invisible while masked (the input renders empty), so a half-typed
  // fragment autosaved mid-typing would overwrite the real key with a value
  // the user never finished entering. The explicit commit (blur or Enter) is
  // the single point where a key edit becomes saveable — the debounced save
  // and its unmount flush therefore only ever carry committed values.
  const commitApiKeyDraft = () => {
    setIsApiKeyFocused(false)
    // Empty input maps to the masked sentinel: the backend keeps the stored
    // key on it (an empty field must not be able to clear a configured key).
    const committed = apiKeyInput.trim() === '' ? MASKED_API_KEY : apiKeyInput
    if (committed === config.api_key) return
    const newConfig = { ...config, api_key: committed }
    setConfig(newConfig)
    debouncedSave(newConfig)
  }

  // commitBaseUrlDraft moves a Base URL edit from the local draft into the
  // saved config on the explicit commit (blur or Enter) — the same pattern as
  // the API key — so a half-typed URL is never autosaved mid-keystroke and
  // rejected by the backend's validation while still incomplete.
  const commitBaseUrlDraft = () => {
    const committed = baseUrlInput.trim()
    if (committed === config.base_url) return
    const newConfig = { ...config, base_url: committed }
    setConfig(newConfig)
    debouncedSave(newConfig)
  }

  const handleProviderChange = (value: string) => {
    const newConfig = { ...config, provider: value }
    setConfig(newConfig)
    // Switching to searxng surfaces the instance URL that will be used: the
    // backend seeds the local-instance default when the field is empty.
    setBaseUrlInput(value === 'searxng' ? (newConfig.base_url || SEARXNG_DEFAULT_BASE_URL) : newConfig.base_url)
    debouncedSave(newConfig)
  }

  const handleApiKeyFocus = () => {
    setIsApiKeyFocused(true)
    if (config.api_key === MASKED_API_KEY) setApiKeyInput('')
  }

  const handleApiKeyKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitApiKeyDraft()
    }
  }

  const handleBaseUrlKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitBaseUrlDraft()
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <span className="text-sm text-muted-foreground">Loading search settings...</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6" data-testid="web-search-provider-settings">
      <div className="flex flex-col gap-2">
        {/* Section heading in the shared settings style — icon + text-sm
            font-medium, like "Default Model" (LLMSettings) and the section
            headers in SettingsModal ("HTTP Proxy" carries the same Globe). */}
        <label className="flex items-center gap-2 text-sm font-medium">
          <Globe className="h-4 w-4 text-muted-foreground" />
          Web Search Provider
        </label>
        <Combobox
          ariaLabel="Search provider"
          value={config.provider}
          onChange={handleProviderChange}
          className="min-w-[180px]"
          options={PROVIDER_KEYS.map((key) => ({ value: key, label: PROVIDER_DISPLAY_NAMES[key] ?? key }))}
        />
      </div>

      <SearchProviderNotices
        provider={config.provider}
        missingApiKey={
          config.api_key !== MASKED_API_KEY &&
          apiKeyInput.trim() === '' &&
          !NO_API_KEY_PROVIDERS.includes(config.provider)
        }
      />

      {!NO_API_KEY_PROVIDERS.includes(config.provider) && (
        <div className="flex flex-col gap-2">
          <label className="text-xs text-muted-foreground">API Key</label>
          <Input
            type={apiKeyInput.startsWith('${') ? 'text' : 'password'}
            placeholder={
              config.api_key === MASKED_API_KEY && !isApiKeyFocused ? '••••••••••••••••' : 'Enter API key'
            }
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            onFocus={handleApiKeyFocus}
            onBlur={commitApiKeyDraft}
            onKeyDown={handleApiKeyKeyDown}
            className="h-9 text-sm"
          />
          <p className="text-xs text-muted-foreground">
            {config.api_key === MASKED_API_KEY
              ? 'API key is configured. Enter a new value to change it.'
              : 'Enter your API key for the search provider.'}
          </p>
        </div>
      )}

      {config.provider === 'searxng' && (
        <div className="flex flex-col gap-2">
          <label className="text-xs text-muted-foreground">Instance URL</label>
          <Input
            type="text"
            data-testid="searxng-base-url"
            placeholder={`${SEARXNG_DEFAULT_BASE_URL} (default)`}
            value={baseUrlInput}
            onChange={(e) => setBaseUrlInput(e.target.value)}
            onBlur={commitBaseUrlDraft}
            onKeyDown={handleBaseUrlKeyDown}
            className="h-9 text-sm"
          />
          <p className="text-xs text-muted-foreground">
            URL of your self-hosted SearXNG instance. The instance must enable JSON output
            (settings.yml: search.formats: [html, json]).
          </p>
        </div>
      )}

      {saveError && <p className="text-sm text-destructive mt-2">{saveError}</p>}
    </div>
  )
}
