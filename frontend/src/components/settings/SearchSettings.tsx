import { IndexingSettings } from './IndexingSettings'
import { WebSearchProviderSettings } from './WebSearchProviderSettings'

/**
 * The Search settings tab, in fixed block order:
 *
 * 1. Indexing — the vector-index master switch plus (while enabled) the
 *    exclude-glob editor, the submodule / .gitignore / .aiignore toggles,
 *    and the embedder half (execution provider, device, diagnostics). With
 *    indexing off only the master switch remains — everything
 *    indexing-related hides with it.
 * 2. Web Search Provider — the provider picker, API key, and SearXNG
 *    instance URL. Independent of the indexing switch: web search stays
 *    configurable while the workspace index is off.
 */
export function SearchSettings() {
  return (
    <div className="space-y-6">
      <IndexingSettings />
      <div className="border-t border-border pt-4">
        <WebSearchProviderSettings />
      </div>
    </div>
  )
}
