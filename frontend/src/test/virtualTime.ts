import { act } from 'react'
import { vi } from 'vitest'

/**
 * Run `step` with the macrotask clock VIRTUALIZED — the timing-guard
 * (`internal/testtiming`) compliant replacement for
 * `new Promise((r) => setTimeout(r, ms))` waits around Radix interactions.
 *
 * setTimeout/clearTimeout are faked BEFORE `step` runs, so every timer the
 * step schedules (Radix's post-open `setTimeout(0)` listener attach, the
 * typeahead's deferred item focus) lands on the virtual clock; the advance
 * then deterministically fires everything due within `ms`, including timers
 * chained by earlier callbacks. Microtasks, rAF, MessageChannel and Date stay
 * real, so React's scheduler and promise-driven flows behave as before, and
 * pending timers beyond the window stay pending — mirroring what a real wait
 * of the same length would (not) have fired.
 *
 * The action must happen INSIDE the window: installing the fake clock after
 * the fact cannot see timers already scheduled on the real one.
 *
 * Timer callbacks run inside `act`, so React state updates they trigger are
 * flushed and never produce act() warnings.
 */
export async function withVirtualTimers(
  step: () => void | Promise<void>,
  ms = 0,
): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    await act(async () => {
      await step()
      await vi.advanceTimersByTimeAsync(ms)
    })
  } finally {
    vi.useRealTimers()
  }
}
