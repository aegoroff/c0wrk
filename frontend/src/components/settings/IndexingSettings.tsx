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
 * backend, so saves are immediate with no debounce. Commits are serialized
 * through a promise tail (the Wails bridge gives concurrent RPCs no
 * ordering guarantee, while the backend's saveMu applies them in arrival
 * order) and identity-guarded on settle: only the latest commit may revert
 * the form, so a late failure cannot clobber a newer optimistic state —
 * the form converges on the last backend-confirmed policy instead. A
 * failed save surfaces the error.
 */
export function IndexingSettings() {
  const [policy, setPolicy] = useState<IndexingSettingsRequest>(DEFAULT_POLICY)
  const [isLoading, setIsLoading] = useState(true)
  const [saveError, setSaveError] = useState<string | null>(null)
  // The committed-policy ref lets `commit` build the next full request from
  // the latest state without a stale-closure dependency on `policy`.
  const policyRef = useRef(policy)
  // The last backend-confirmed policy: updated by every settled success, it
  // is what a failed commit reverts the form to (its own optimistic
  // predecessor may itself have been rejected — `persisted` is the state
  // the backend actually holds).
  const persistedRef = useRef(policy)
  // Serialization tail: each commit's RPC dispatch awaits the previous
  // commit's settle, so arrival order at the backend matches the policy's
  // evolution and an older full-replacement can never be applied last.
  const commitTailRef = useRef<Promise<void>>(Promise.resolve())

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
          persistedRef.current = policyRef.current
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
    const run = async (): Promise<void> => {
      try {
        await updateIndexingSettings(next)
        persistedRef.current = next
        setSaveError(null)
        // Keep the app-wide indexing gate in sync — Settings is the store's
        // direct writer after hydration (useIndexingSettings only fetches
        // once; see the store's doc comment). Only a confirmed save flips
        // the gated surfaces, never the optimistic control state.
        useIndexingSettingsStore.getState().setEnabled(next.enabled)
      } catch (err) {
        logger.error('Failed to save indexing settings:', err)
        // Identity guard: only the LATEST commit may settle the form. A
        // stale failure must not clobber a newer optimistic state — that
        // commit is a full replacement of this one's content, and its own
        // settle (success, or its own guarded failure) converges the form
        // with the backend. The store is deliberately untouched here: it
        // mirrors the last confirmed save, which is exactly what the revert
        // restores.
        if (policyRef.current === next) {
          const persisted = persistedRef.current
          policyRef.current = persisted
          setPolicy(persisted)
          setSaveError(err instanceof Error ? err.message : 'Failed to save indexing settings')
        }
      }
    }
    // Queue behind the previous commit; swallow its outcome so one rejection
    // cannot strand the tail (the failure was already handled in `run`).
    commitTailRef.current = commitTailRef.current.then(run, run)
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
