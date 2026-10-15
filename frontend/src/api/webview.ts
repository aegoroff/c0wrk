// Webview GPU-policy API (issue #34) — Linux-only webview hardware-acceleration
// setting, persisted in webview_state.json and consumed at webview creation.

import { logger } from '@/lib/logger'

export type WebviewGpuPolicySetting = 'auto' | 'always' | 'on-demand' | 'never'

export interface WebviewGpuFallbackInfo {
  policy: string
  reason: string
  detected_at: string
}

export interface WebviewGpuPolicyInfo {
  setting: WebviewGpuPolicySetting
  running: string
  running_source: string
  fallback: WebviewGpuFallbackInfo | null
  restart_required: boolean
  linux_only: boolean
}

const WEBVIEW_GPU_SETTINGS: readonly WebviewGpuPolicySetting[] = ['auto', 'always', 'on-demand', 'never']

/** Boundary type guard: malformed bridge payloads are dropped, never rendered. */
function isWebviewGpuPolicyInfo(value: unknown): value is WebviewGpuPolicyInfo {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (!WEBVIEW_GPU_SETTINGS.includes(v.setting as WebviewGpuPolicySetting)) return false
  if (typeof v.running !== 'string' || typeof v.running_source !== 'string') return false
  if (typeof v.restart_required !== 'boolean' || typeof v.linux_only !== 'boolean') return false
  if (v.fallback === null || v.fallback === undefined) return true
  if (typeof v.fallback !== 'object') return false
  const fb = v.fallback as Record<string, unknown>
  return typeof fb.policy === 'string' && typeof fb.reason === 'string' && typeof fb.detected_at === 'string'
}

async function callApp<T>(method: string, guard: (v: unknown) => v is T, ...args: unknown[]): Promise<T> {
  if (typeof window === 'undefined' || !window.go?.desktop?.App) {
    throw new Error('Wails runtime unavailable')
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await (window.go.desktop.App as any)[method](...args)
  if (!guard(raw)) {
    throw new Error(`malformed ${method} payload`)
  }
  return raw
}

/** Reports the persisted setting, the running policy, and the watchdog fallback. */
export function getWebviewGpuPolicy(): Promise<WebviewGpuPolicyInfo> {
  return callApp('GetWebviewGpuPolicy', isWebviewGpuPolicyInfo)
}

/**
 * Persists the user's choice. Any explicit choice clears the watchdog
 * fallback: a concrete policy pins itself, and re-choosing auto is the
 * "retry accelerated rendering" action. Applies on the next app start.
 */
export function setWebviewGpuPolicy(setting: WebviewGpuPolicySetting): Promise<WebviewGpuPolicyInfo> {
  if (!WEBVIEW_GPU_SETTINGS.includes(setting)) {
    return Promise.reject(new Error(`unknown webview GPU policy setting: ${setting}`))
  }
  return callApp('SetWebviewGpuPolicy', isWebviewGpuPolicyInfo, setting).catch((err) => {
    logger.error('SetWebviewGpuPolicy failed:', err)
    throw err
  })
}
