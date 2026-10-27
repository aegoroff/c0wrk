import { useCallback, useEffect, useRef, useState } from 'react'
import { Database } from 'lucide-react'
import { getConfig, updateIndexingSettings } from '@/api/config'
import { logger } from '@/lib/logger'
import type { IndexingSettingsRequest } from '@/types/models'
import { useIndexingSettingsStore } from '@/stores/indexingSettingsStore'
import { Toggle } from './ModelProfilesControls'
import { ExcludeGlobsEditor } from './ExcludeGlobsEditor'
import { VectorIndexSettings } from './VectorIndexSettings'

/**
 * Resolved defaults mirroring the backend's nil-pointer resolution for a
 * config that predates the knobs (or a GetConfig payload without the
 * vector_index block): indexing on, no patterns, submodules off, both
 * ignore files honoured — the historical always-on behaviour.
 */
const DEFAULT_POLICY: IndexingSettingsRequest = {
  enabled: true,
  exclude_patterns: [],
  index_submodules: false,
  respect_gitignore: true,
  respect_aiignore: true,
}

/**
 * Search-tab section for the vector-index indexing policy: the master
 * "Indexing enabled" switch plus — only while indexing is on — the
 * exclude-glob editor, the submodule / .gitignore / .aiignore toggles, and
 * the embedder half (execution provider, device, runtime diagnostics).
 *
 * Every interaction is a discrete commit that sends the FULL policy
 * (UpdateIndexingSettings is a full replacement — flipping the master
 * switch must not drop the stored patterns) and is applied live by the
 * backend, so saves are immediate with no debounce. A failed save reverts
 * the control to the persisted state and surfaces the error.
 */
export function IndexingSettings() {
  const [policy, setPolicy] = useState<IndexingSettingsRequest>(DEFAULT_POLICY)
  const [isLoading, setIsLoading] = useState(true)
  const [saveError, setSaveError] = useState<string | null>(null)
  // The committed-policy ref lets `commit` build the next full request from
  // the latest state without a stale-closure dependency on `policy`.
  const policyRef = useRef(policy)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const result = await getConfig()
        if (cancelled) return
        const vi = result.vector_index
        if (vi) {
          policyRef.current = {
            enabled: vi.enabled ?? true,
            exclude_patterns: vi.exclude_patterns ?? [],
            index_submodules: vi.index_submodules ?? false,
            respect_gitignore: vi.respect_gitignore ?? true,
            respect_aiignore: vi.respect_aiignore ?? true,
          }
          setPolicy(policyRef.current)
        }
      } catch (err) {
        logger.error('Failed to load indexing settings:', err)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const commit = useCallback((patch: Partial<IndexingSettingsRequest>) => {
    const prev = policyRef.current
    const next = { ...prev, ...patch }
    policyRef.current = next
    setPolicy(next)
    updateIndexingSettings(next)
      .then(() => {
        setSaveError(null)
        // Keep the app-wide indexing gate in sync — Settings is the store's
        // direct writer after hydration (useIndexingSettings only fetches
        // once; see the store's doc comment). Only a confirmed save flips
        // the gated surfaces, never the optimistic control state.
        useIndexingSettingsStore.getState().setEnabled(next.enabled)
      })
      .catch((err) => {
        logger.error('Failed to save indexing settings:', err)
        // The backend rejects before writing, so the persisted policy is
        // still `prev` — put the control back and say why.
        policyRef.current = prev
        setPolicy(prev)
        setSaveError(err instanceof Error ? err.message : 'Failed to save indexing settings')
      })
  }, [])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <span className="text-sm text-muted-foreground">Loading indexing settings...</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4" data-testid="indexing-settings">
      <div className="flex items-center gap-2">
        <Database className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">Indexing</span>
      </div>
      <Toggle
        checked={policy.enabled}
        onChange={(enabled) => commit({ enabled })}
        label="Indexing enabled"
        description="Master switch for the workspace vector index (semantic search and retrieval). Turning it off stops indexing and hides the index settings below; the web-search provider section stays."
      />
      {policy.enabled && (
        <div className="flex flex-col gap-4" data-testid="indexing-policy-controls">
          <ExcludeGlobsEditor
            patterns={policy.exclude_patterns}
            onChange={(exclude_patterns) => commit({ exclude_patterns })}
          />
          <Toggle
            checked={policy.index_submodules}
            onChange={(index_submodules) => commit({ index_submodules })}
            label="Index Git submodules"
            description="Walk git submodules under the workspace root and index their files. Off by default — submodules are skipped unless explicitly opted in."
          />
          <Toggle
            checked={policy.respect_gitignore}
            onChange={(respect_gitignore) => commit({ respect_gitignore })}
            label="Respect .gitignore"
            description="Files matched by .gitignore rules stay out of the index walk."
          />
          <Toggle
            checked={policy.respect_aiignore}
            onChange={(respect_aiignore) => commit({ respect_aiignore })}
            label="Respect .aiignore"
            description="Files matched by .aiignore rules stay out of the index walk."
          />
          <div className="border-t border-border pt-4">
            <div className="flex items-center gap-2 mb-3">
              <Database className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Vector Index</span>
            </div>
            <VectorIndexSettings />
          </div>
        </div>
      )}
      {saveError && <p className="text-sm text-destructive">{saveError}</p>}
    </div>
  )
}
