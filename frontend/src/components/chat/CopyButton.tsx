import { useState, useCallback, useEffect, useRef } from 'react'
import { Copy, Check, Save, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { clipboardSetText, emit, isWebTransport } from '@/api/runtime'
import { saveMessageAsMarkdown } from '@/api/files'
import { useShiftHeld } from '@/hooks/useShiftHeld'
import { logger } from '@/lib/logger'
import { generateUUID } from '@/lib/ids'

interface CopyButtonProps {
  /** Text copied to the clipboard on click (or saved to a file on Shift+click). */
  text: string
  /** Accessible label / tooltip shown in the idle state. */
  label?: string
  className?: string
}

/** Which success state the button is flashing, if any. */
type Feedback = 'copied' | 'saved' | 'download-started' | 'failed' | null

/**
 * CopyButton — small, low-contrast copy-to-clipboard control.
 *
 * Renders a `Copy` icon plus a text label that flips to a success `Check` +
 * "Copied" for a short window after a successful copy. While Shift is held
 * the button morphs into a `Save` action: clicking opens the native save-file
 * dialog (default directory = the active project) and writes the text to the
 * chosen .md file, flashing "Saved" on success. The button itself is always
 * visible; the hover reveal that shows/hides it in chat messages is handled
 * by the parent via a `group` + `group-hover:*` wrapper.
 */
export function CopyButton({ text, label = 'Copy', className }: CopyButtonProps) {
  const [feedback, setFeedback] = useState<Feedback>(null)
  const shiftHeld = useShiftHeld()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const flashFeedback = useCallback((kind: Exclude<Feedback, null>) => {
    setFeedback(kind)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setFeedback(null), 2000)
  }, [])

  const handleCopy = useCallback(() => {
    // Copy through the native Wails runtime, NOT `navigator.clipboard`. The
    // Web Clipboard API is unreliable inside the Wails webview
    // (`navigator.clipboard` is undefined in production because the webview
    // origin is not a secure context, and even when present `writeText`
    // rejects with NotAllowedError under WKWebView's transient-activation
    // rules) — that was the root cause of the message copy buttons needing
    // several clicks to register. See `clipboardSetText` in @/api/runtime.
    clipboardSetText(text)
      .then((ok) => {
        // `false` is a failed copy (see `clipboardSetText`) — it must never
        // render the success state.
        flashFeedback(ok ? 'copied' : 'failed')
      })
      .catch(() => {
        // `clipboardSetText` resolves instead of throwing; this is a safety
        // net — fail with the same visible signal rather than silently.
        flashFeedback('failed')
      })
  }, [text, flashFeedback])

  const handleSave = useCallback(() => {
    if (isWebTransport()) {
      // Web transport: there is no native save dialog — hand the browser a
      // plain anchor download instead (the trivially-replaceable native
      // dialog from the roadmap). A revoked object URL after the click is
      // safe: the download has already been handed to the browser.
      const blob = new Blob([text], { type: 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'message.md'
      anchor.click()
      URL.revokeObjectURL(url)
      // The anchor click cannot report failure (a popup blocker can eat it
      // silently) — claim only that the download was handed to the browser.
      flashFeedback('download-started')
      return
    }
    saveMessageAsMarkdown(text)
      .then((path) => {
        // An empty path means the user cancelled the native dialog — no
        // feedback, the button simply stays in its idle Save state.
        if (path) flashFeedback('saved')
      })
      .catch((err) => {
        // Unlike clipboard writes, a failed save (dialog error, unwritable
        // path) is invisible without a toast — surface it.
        logger.error('Failed to save message to file:', err)
        emit('runtime_error', {
          id: generateUUID(),
          message: 'Failed to save message to file',
        })
      })
  }, [text, flashFeedback])

  const currentLabel =
    feedback === 'copied'
      ? 'Copied'
      : feedback === 'saved'
        ? 'Saved'
        : feedback === 'download-started'
          ? 'Download started'
          : feedback === 'failed'
            ? 'Failed'
            : shiftHeld
              ? 'Save'
              : label
  const Icon =
    feedback === 'failed' ? X : feedback !== null ? Check : shiftHeld ? Save : Copy

  return (
    <button
      type="button"
      onClick={shiftHeld ? handleSave : handleCopy}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors',
        className,
      )}
      title={currentLabel}
      aria-label={currentLabel}
    >
      <Icon
        className={cn(
          'h-3.5 w-3.5',
          feedback === 'failed' ? 'text-destructive' : feedback !== null && 'text-success',
        )}
      />
      <span>{currentLabel}</span>
    </button>
  )
}
