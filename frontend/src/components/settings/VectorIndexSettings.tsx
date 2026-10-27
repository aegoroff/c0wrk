import { useState, useEffect, useCallback, useRef } from 'react'
import { RefreshCw } from 'lucide-react'
import { Combobox } from '@/components/ui/combobox'
import { getConfig, updateVectorIndexSettings } from '@/api/config'
import { listVectorIndexGPUs } from '@/api/vector'
import { useVectorIndexStore } from '@/stores/vectorIndexStore'
import { logger } from '@/lib/logger'
import { isLinuxHost } from '@/lib/platform'
import { VectorIndexDevicePicker } from './VectorIndexDevicePicker'
import { VectorIndexDiagnostics } from './VectorIndexDiagnostics'
import type { ExecutionProvider, GPUDeviceResponse } from '@/types/models'

const PROVIDER_DISPLAY_NAMES: Record<ExecutionProvider, string> = {
  auto: 'Auto (CUDA → OpenVINO → CPU)',
  cpu: 'CPU',
  cuda: 'CUDA (NVIDIA GPU)',
  openvino: 'OpenVINO (Intel GPU)',
}

const PROVIDER_DESCRIPTIONS: Record<ExecutionProvider, string> = {
  auto: 'Try the NVIDIA CUDA provider first, then OpenVINO for Intel hardware; fall back to CPU when neither hardware provider is usable.',
  cpu: 'Always run the embedder on CPU. Use when GPU acceleration is unwanted or unstable.',
  cuda: 'Require an NVIDIA GPU. Falls back to CPU with a warning when CUDA init fails.',
  openvino: 'Target Intel GPUs via the OpenVINO execution provider. Requires the OpenVINO provider plugin; falls back to CPU with a warning when it fails to load.',
}

const PROVIDER_OPTIONS = (Object.keys(PROVIDER_DISPLAY_NAMES) as ExecutionProvider[]).map((key) => ({
  value: key,
  label: PROVIDER_DISPLAY_NAMES[key],
}))

/** Device ids are ONNX ordinals: whole numbers, first GPU is 0. */
function parseDeviceId(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '' || !/^\d+$/.test(trimmed)) return null
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

interface SavedConfig {
  execution_provider: ExecutionProvider
  device_id: number
}

const DEFAULT_CONFIG: SavedConfig = { execution_provider: 'auto', device_id: 0 }

/**
 * Embedder half of the Search tab's Indexing section: the vector-index
 * embedder's ONNX Runtime execution provider and GPU device. Saves are
 * validated client-side, then validated
 * and persisted by the backend with no hot application — the embedder is
 * created once per process, so a changed provider/device only takes effect
 * after an app restart. The restart hint and diagnostics block make that
 * contract visible instead of letting edits look ignored.
 *
 * The provider/device controls are Linux-host-only (`isLinuxHost()`): the
 * hardware-acceleration flavors they configure (CUDA, OpenVINO) ship as
 * linux/amd64 builds (ADR-046) and Windows/macOS hardware acceleration is a
 * separate future implementation. Off Linux the
 * section renders a muted note plus the cross-platform diagnostics block —
 * and issues neither mount-time RPC nor any save.
 */
export function VectorIndexSettings() {
  const status = useVectorIndexStore((s) => s.status)

  // Provider/device selection ships for Linux hosts only: the hardware
  // acceleration flavors (CUDA, OpenVINO) are linux/amd64 builds
  // (ADR-046) and Windows/macOS hardware
  // acceleration is a separate future implementation. The runtime
  // diagnostics below stay cross-platform — they describe whatever embedder
  // is actually running.
  const showControls = isLinuxHost()

  const [config, setConfig] = useState<SavedConfig>(DEFAULT_CONFIG)
  const [isLoading, setIsLoading] = useState(true)
  const [gpus, setGpus] = useState<GPUDeviceResponse[]>([])
  const [gpusLoaded, setGpusLoaded] = useState(false)
  const [gpuLoadError, setGpuLoadError] = useState<string | null>(null)
  const [deviceInput, setDeviceInput] = useState('0')
  const [saveError, setSaveError] = useState<string | null>(null)
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const pendingConfigRef = useRef<SavedConfig | null>(null)

  // Load the persisted config; the GPU probe runs in parallel so a slow
  // nvidia-smi never delays rendering the saved provider/device. Skipped
  // entirely off Linux: without the controls there is nothing to hydrate,
  // so the section skips straight past the loading state.
  useEffect(() => {
    if (!showControls) {
      setIsLoading(false)
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const result = await getConfig()
        if (cancelled) return
        if (result?.vector_index) {
          setConfig(result.vector_index)
          setDeviceInput(String(result.vector_index.device_id))
        }
      } catch (err) {
        logger.error('Failed to load vector index config:', err)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
    // `showControls` is host-constant for the app's lifetime; it appears in
    // deps only to satisfy exhaustive-deps — the effect runs once per mount.
  }, [showControls])

  // GPU list for the device picker. An empty list is the "no nvidia-smi"
  // path (numeric fallback input). A rejection means the probe itself failed
  // (driver present but broken); diagnostics degrade to the numeric fallback
  // with the failure surfaced next to it. Off Linux the probe never runs.
  useEffect(() => {
    if (!showControls) return
    let cancelled = false
    const load = async () => {
      try {
        const list = await listVectorIndexGPUs()
        if (cancelled) return
        setGpus(list)
        setGpusLoaded(true)
      } catch (err) {
        if (cancelled) return
        logger.error('Failed to list vector index GPUs:', err)
        setGpuLoadError('GPU probe failed — enter the device index manually.')
        setGpusLoaded(true)
      }
    }
    void load()
    return () => { cancelled = true }
    // See the config-load effect above for why `showControls` is in deps.
  }, [showControls])

  const saveSettings = useCallback(async (newConfig: SavedConfig) => {
    try {
      await updateVectorIndexSettings(newConfig)
      setSaveError(null)
    } catch (err) {
      logger.error('Failed to save vector index settings:', err)
      setSaveError('Failed to save vector index settings')
    }
  }, [])

  const debouncedSave = useCallback((newConfig: SavedConfig) => {
    pendingConfigRef.current = newConfig
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null
      pendingConfigRef.current = null
      void saveSettings(newConfig)
    }, 500)
  }, [saveSettings])

  // Radix Tabs unmount inactive TabsContent: leaving the General tab (or
  // closing the modal) unmounts this section. Flush a pending debounced save
  // so an edit followed by an immediate tab switch is not lost.
  useEffect(() => () => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }
    const pending = pendingConfigRef.current
    pendingConfigRef.current = null
    if (pending) void saveSettings(pending)
  }, [saveSettings])

  const handleProviderChange = (value: string) => {
    const provider = value as ExecutionProvider
    const newConfig = { ...config, execution_provider: provider }
    // The OpenVINO plugin surface accepts device 0 only (it picks the
    // concrete Intel device itself); normalize the saved pair so a switch
    // to openvino can never persist a device id the embedder would reject
    // at creation time.
    if (provider === 'openvino' && newConfig.device_id !== 0) {
      newConfig.device_id = 0
      setDeviceInput('0')
    }
    setConfig(newConfig)
    debouncedSave(newConfig)
  }

  const handleDeviceChange = (value: string) => {
    setDeviceInput(value)
    const parsed = parseDeviceId(value)
    // Never persist an invalid id — the backend would reject the whole
    // update; keep it buffered instead. The invalid-input alert is DERIVED
    // from the input (below), so re-entering any valid value — including the
    // one already persisted — clears it immediately.
    if (parsed === null) return
    if (parsed === config.device_id) return
    const newConfig = { ...config, device_id: parsed }
    setConfig(newConfig)
    debouncedSave(newConfig)
  }

  // Derived by construction: the alert shows exactly while the input does not
  // parse as a valid device id, so it can never go stale (e.g. correcting an
  // invalid entry back to the persisted value clears it with the input).
  const deviceError = parseDeviceId(deviceInput) === null ? 'Device id must be a whole number ≥ 0.' : null

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <span className="text-sm text-muted-foreground">Loading vector index settings...</span>
      </div>
    )
  }

  const deviceDisabled = config.execution_provider === 'cpu'
  // OpenVINO accepts device 0 only (the plugin picks the concrete Intel
  // device), so the control is pinned with its own explanation rather than
  // the CPU note.
  const devicePinnedReason = config.execution_provider === 'openvino'
    ? 'OpenVINO always runs on device 0 — the plugin picks the concrete Intel device itself.'
    : undefined

  // ── Restart-pending detection ────────────────────────────────────────
  // The running embedder's creation-time facts travel in VectorIndexStatus;
  // the saved config is what the NEXT restart will use. A divergence means
  // the running embedder predates the config change → restart required.
  const runningProvider = status?.requested_execution_provider
  const runningDeviceId = status?.device_id ?? 0
  const restartPending =
    typeof runningProvider === 'string' &&
    (runningProvider !== config.execution_provider || runningDeviceId !== config.device_id)

  return (
    <div className="flex flex-col gap-4">
      {!showControls && (
        <p data-testid="vector-controls-unavailable" className="text-xs text-muted-foreground">
          Execution-provider and GPU-device selection is available on Linux hosts only —
          the hardware acceleration it configures (CUDA, OpenVINO) ships as Linux builds,
          and Windows/macOS hardware acceleration is a separate future implementation.
          The runtime diagnostics below still apply.
        </p>
      )}

      {showControls && (
        <div className="flex flex-col gap-2">
          <label className="text-xs text-muted-foreground">Execution Provider</label>
          <Combobox
            ariaLabel="Embedder execution provider"
            value={config.execution_provider}
            onChange={handleProviderChange}
            className="min-w-[180px]"
            options={PROVIDER_OPTIONS}
          />
          <p className="text-xs text-muted-foreground">
            {PROVIDER_DESCRIPTIONS[config.execution_provider]}
          </p>
        </div>
      )}

      {showControls && (
        <VectorIndexDevicePicker
          gpus={gpus}
          gpusLoaded={gpusLoaded}
          disabled={deviceDisabled}
          pinnedReason={devicePinnedReason}
          provider={config.execution_provider}
          value={config.device_id}
          input={deviceInput}
          error={deviceError}
          probeError={gpuLoadError}
          onChange={handleDeviceChange}
        />
      )}

      <VectorIndexDiagnostics status={status} />

      {showControls && restartPending && (
        <div
          data-testid="vector-restart-hint"
          className="flex items-start gap-2 rounded-md border border-info/30 bg-info/10 p-3 text-sm text-info"
        >
          <RefreshCw className="mt-0.5 size-4 shrink-0" />
          <p className="text-xs">
            Restart required: saved settings ({config.execution_provider}, device{' '}
            {config.device_id}) differ from what the running embedder uses (
            {runningProvider}, device {runningDeviceId}). The embedder is created once
            per app start; reload the app to apply the change.
          </p>
        </div>
      )}

      {showControls && saveError && (
        <p className="text-sm text-destructive mt-2">{saveError}</p>
      )}
    </div>
  )
}
