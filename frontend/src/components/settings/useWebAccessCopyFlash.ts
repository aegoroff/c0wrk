import { useCallback, useEffect, useRef, useState } from 'react'
import { clipboardSetText, emit } from '@/api/runtime'
import { logger } from '@/lib/logger'
import { generateUUID } from '@/lib/ids'

/**
 * Shared copy-with-flash behavior for the Web Access fields (ADR-101): the
 * write goes through `clipboardSetText` — a `false` verdict (or a rejection,
 * folded in defensively) is a FAILED copy: logged, surfaced as a
 * `runtime_error` toast, and never allowed to flash the success state — and
 * a success flips `copied` for 1.6 s. Each field owns one instance (the URL
 * and the token flash independently); the timer is cleared on unmount so it
 * never fires into an unmounted component.
 */
export function useWebAccessCopyFlash(): { copied: boolean; copy: (text: string) => Promise<void> } {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  const copy = useCallback(async (text: string) => {
    const ok = await clipboardSetText(text).catch(() => false)
    if (!ok) {
      logger.error('Failed to copy to clipboard')
      emit('runtime_error', {
        id: generateUUID(),
        message: 'Failed to copy to clipboard',
      })
      return
    }
    setCopied(true)
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1600)
  }, [])

  return { copied, copy }
}
