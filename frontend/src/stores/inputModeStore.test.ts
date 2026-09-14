// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'

// jsdom in this environment does not expose `window.localStorage`, which
// zustand's `persist` middleware captures at store-creation time. Install an
// in-memory polyfill before the store module is imported (same pattern as
// uiScaleStore.test.ts).
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>
  const win = (g.window as Record<string, unknown> | undefined) ?? g
  const map = new Map<string, string>()
  win.localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v) },
    removeItem: (k: string) => { map.delete(k) },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size },
  }
})

import { useInputModeStore } from './inputModeStore'

const PERSIST_KEY = 'c0wrk-input-mode'

beforeEach(() => {
  useInputModeStore.setState({ goalEnabled: false, goalBudget: '', e2sEnabled: false })
  localStorage.clear()
})

describe('inputModeStore e2s/goal mutual exclusion', () => {
  it('defaults e2sEnabled to false', () => {
    expect(useInputModeStore.getState().e2sEnabled).toBe(false)
  })

  it('enabling E2S disables goal mode', () => {
    useInputModeStore.setState({ goalEnabled: true })
    useInputModeStore.getState().setE2sEnabled(true)
    expect(useInputModeStore.getState().e2sEnabled).toBe(true)
    expect(useInputModeStore.getState().goalEnabled).toBe(false)
  })

  it('enabling goal mode disables E2S', () => {
    useInputModeStore.setState({ e2sEnabled: true })
    useInputModeStore.getState().setGoalEnabled(true)
    expect(useInputModeStore.getState().goalEnabled).toBe(true)
    expect(useInputModeStore.getState().e2sEnabled).toBe(false)
  })

  it('disabling one mode does not arm the other', () => {
    useInputModeStore.setState({ goalEnabled: true, e2sEnabled: true }) // direct setState bypasses actions
    useInputModeStore.getState().setGoalEnabled(false)
    // Turning goal off merely disarms goal — it must not silently arm E2S.
    expect(useInputModeStore.getState().goalEnabled).toBe(false)
    expect(useInputModeStore.getState().e2sEnabled).toBe(true)

    useInputModeStore.getState().setE2sEnabled(false)
    expect(useInputModeStore.getState().e2sEnabled).toBe(false)
    expect(useInputModeStore.getState().goalEnabled).toBe(false)
  })

  it('setE2sEnabled(false) leaves goal mode untouched', () => {
    useInputModeStore.setState({ goalEnabled: true })
    useInputModeStore.getState().setE2sEnabled(false)
    expect(useInputModeStore.getState().goalEnabled).toBe(true)
    expect(useInputModeStore.getState().e2sEnabled).toBe(false)
  })
})

describe('inputModeStore goal disarm (SLM gate)', () => {
  it('disarmGoal clears an armed goal toggle', () => {
    useInputModeStore.setState({ goalEnabled: true })
    useInputModeStore.getState().disarmGoal()
    expect(useInputModeStore.getState().goalEnabled).toBe(false)
  })

  it('disarmGoal is a no-op when goal mode is already off', () => {
    useInputModeStore.setState({ goalEnabled: false })
    useInputModeStore.getState().disarmGoal()
    expect(useInputModeStore.getState().goalEnabled).toBe(false)
  })
})

describe('inputModeStore persistence', () => {
  it('persists e2sEnabled (unlike goalEnabled) under the c0wrk-input-mode key', () => {
    useInputModeStore.getState().setE2sEnabled(true)
    const raw = localStorage.getItem(PERSIST_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw as string) as {
      state: Record<string, unknown>
      version: number
    }
    expect(parsed.state.e2sEnabled).toBe(true)
    // goalEnabled/goalBudget stay memory-only (per-task opt-in, v3→v4
    // migration strips them) — persistence must not resurrect them.
    expect('goalEnabled' in parsed.state).toBe(false)
    expect('goalBudget' in parsed.state).toBe(false)
  })

  it('persists e2sEnabled=false after the toggle is disarmed', () => {
    useInputModeStore.getState().setE2sEnabled(true)
    useInputModeStore.getState().setE2sEnabled(false)
    const raw = localStorage.getItem(PERSIST_KEY)
    const parsed = JSON.parse(raw as string) as { state: Record<string, unknown> }
    expect(parsed.state.e2sEnabled).toBe(false)
  })
})
