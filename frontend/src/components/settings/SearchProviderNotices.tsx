import { AlertTriangle, Info } from 'lucide-react'

interface SearchProviderNoticesProps {
  provider: string
  /** True when the stored API key is empty for a provider that needs one. */
  missingApiKey: boolean
}

/**
 * Guidance banners of the web-search provider section: the DuckDuckGo
 * best-effort warning (only for that provider), the missing-API-key error
 * (only for key-requiring providers without a stored key), and the
 * ever-present provider recommendation note.
 */
export function SearchProviderNotices({ provider, missingApiKey }: SearchProviderNoticesProps) {
  return (
    <>
      {provider === 'duckduckgo' && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-warning/10 border border-warning/20 text-sm">
          <AlertTriangle className="h-4 w-4 text-warning flex-shrink-0 mt-0.5" />
          <p>
            DuckDuckGo is a best-effort scraper with no official API and is subject to its anti-bot
            rate limiting (HTTP 202 anomaly challenges). For reliable search, use an API-backed
            provider (Brave, Tavily, or Exa) or a self-hosted SearXNG instance.
          </p>
        </div>
      )}

      {missingApiKey && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20 text-sm">
          <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
          <p>Search provider API key is not configured.</p>
        </div>
      )}

      <div className="flex items-start gap-2 p-3 rounded-md bg-info/10 text-xs text-muted-foreground">
        <Info className="h-4 w-4 text-info flex-shrink-0 mt-0.5" />
        <p>
          Recommended: an API-backed provider (Brave, Tavily, or Exa — all have free tiers and no
          anti-bot rate limits). A self-hosted SearXNG instance is the fully self-hosted option.
          DuckDuckGo is best-effort only.
        </p>
      </div>
    </>
  )
}
