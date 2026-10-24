// Native OS drag-and-drop → attachment staging, active only in chat mode.
//
// The backend (desktop/startup.go) registers a Wails `OnFileDrop` listener that
// emits the global `files:dropped` event with `{ paths, x, y }` (absolute file
// paths + drop coordinates). This hook subscribes to it and forwards the dropped
// paths to the shared staging pipeline (useStageAttachments) — the SAME pipeline
// the 📎 picker and paste-file use — so vision gating, session-on-demand and
// store sync all behave identically across every entry point.
//
// Wails v2's native drop gives us only the final `drop` event (no
// drag-over/drag-leave from the OS), so the highlight overlay can't rely on the
// Wails path alone. We additionally listen to document-level HTML5
// `dragenter`/`dragover`/`dragleave`/`drop` events purely to drive a CSS
// highlight (preventDefault stops the webview from navigating to the file); the
// actual staging comes from the Wails `files:dropped` event, which is the only
// source that yields absolute paths.
//
// The staging (and the drop-zone highlight it feeds) is active in chat mode
// only: dropping files into the terminal would be surprising. The dragover/
// drop preventDefault (navigation suppression) is NOT mode-gated — in a
// browser tab it is the only thing keeping an accidental drop anywhere over
// the window from navigating the tab to the file's content, discarding the
// whole SPA state.

import { useEffect, useRef, useState } from 'react'
import { isWebTransport, onGlobalEvent } from '@/api/runtime'
import { isFilesDroppedData } from '@/types/events'
import { useStageAttachments } from '@/hooks/useStageAttachments'
import { useInputModeStore } from '@/stores/inputModeStore'

/**
 * Subscribe to file drops and stage the dropped files as attachments.
 *
 * Transport split (ADR-099): in the Wails webview the drop is intercepted at
 * the OS level and arrives as the native `files:dropped` event (absolute
 * paths); a browser tab never sees that event — its HTML5 `drop` event IS the
 * source, and the dropped File objects stage through AttachFileContent. Both
 * transports share the drag-overlay highlighting and the staging pipeline.
 *
 * @param activeSessionId active chat session id (null = the staging pipeline
 *   creates one on demand).
 * @returns dragActive — whether a file is currently being dragged over the
 *   window, for rendering a drop-zone highlight overlay. Always `false` in
 *   terminal mode.
 */
export function useFileDrop(activeSessionId: string | null): {
  dragActive: boolean
} {
  const mode = useInputModeStore((s) => s.mode)
  const { stageAttachmentPaths, stageAttachmentFiles } = useStageAttachments()
  const [dragActive, setDragActive] = useState(false)
  // The HTML5 drag sequence fires many dragenter/dragleave events as the cursor
  // moves between child elements. We ref-count them (per hook instance) so the
  // overlay only hides once the cursor has truly left the window. Owned as a
  // ref rather than a module global so two mounts never share/borrow state.
  const dragEnterCount = useRef(0)

  useEffect(() => {
    // Navigation suppression is NOT mode-gated: preventDefault on dragover/
    // drop is the only thing stopping a browser tab from navigating away to
    // the dropped file's content (the Wails webview has the OS-level
    // OnFileDrop intercept; a browser tab has nothing else). Only the
    // STAGING (and the highlight overlay it feeds) is chat-only — dropping
    // files into the terminal would be surprising.
    const stagingActive = mode === 'chat'

    const resetDrag = () => {
      dragEnterCount.current = 0
      setDragActive(false)
    }
    // A mode switch re-runs this effect: clear any overlay a drag that was
    // in flight at the switch left behind.
    resetDrag()

    // --- Drive the highlight overlay via document-level HTML5 drag events. ---
    // preventDefault on dragover is REQUIRED for the browser to fire `drop` and
    // to suppress its default "open/navigate to the file" behavior. In the
    // Wails webview the dataTransfer is never read (paths come from the Wails
    // event); in a browser tab the drop handler below reads the files from it.

    const onDragEnter = (e: DragEvent) => {
      // Only react to drags carrying files.
      if (!hasFiles(e)) return
      e.preventDefault()
      if (!stagingActive) return
      dragEnterCount.current++
      setDragActive(true)
    }

    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (!stagingActive) return
      // Keep the highlight steady while moving over the window. setState with
      // the same value is a no-op, so this is cheap and avoids a stale-closure
      // read of dragActive.
      setDragActive(true)
    }

    const onDragLeave = () => {
      if (!stagingActive) return
      // dataTransfer may be null/empty on dragleave (notably when leaving the
      // window), so decrement unconditionally to avoid a stuck overlay. The
      // counter is only ever incremented for file drags (onDragEnter), so a
      // non-file dragleave simply clamps at zero.
      dragEnterCount.current = Math.max(0, dragEnterCount.current - 1)
      if (dragEnterCount.current === 0) setDragActive(false)
    }

    // Suppress the default "open file" navigation on every transport and in
    // every input mode; where the files come from differs per transport
    // (below).
    const suppressNavigation = (e: DragEvent) => {
      e.preventDefault()
      resetDrag()
    }

    if (isWebTransport()) {
      // --- Web transport: the HTML5 drop IS the file source. ---
      // There is no Wails OnFileDrop listener in a browser tab and the
      // `files:dropped` event can never fire; the dropped File objects stage
      // through AttachFileContent directly.
      const onDrop = (e: DragEvent) => {
        suppressNavigation(e)
        if (!stagingActive) return
        const files = Array.from(e.dataTransfer?.files ?? [])
        if (files.length === 0) return
        void stageAttachmentFiles(activeSessionId, files)
      }

      document.addEventListener('dragenter', onDragEnter)
      document.addEventListener('dragover', onDragOver)
      document.addEventListener('dragleave', onDragLeave)
      document.addEventListener('drop', onDrop)

      return () => {
        document.removeEventListener('dragenter', onDragEnter)
        document.removeEventListener('dragover', onDragOver)
        document.removeEventListener('dragleave', onDragLeave)
        document.removeEventListener('drop', onDrop)
        // Reset the ref counter so a re-mount (e.g. mode switch back to chat)
        // starts from a clean state.
        dragEnterCount.current = 0
      }
    }

    // --- Wails transport: stage dropped files from the native drop event. ---
    // Wails' native `OnFileDrop` intercepts the drop at the OS level, so the
    // webview never fires the HTML5 `drop`/`dragleave` events that would
    // otherwise hide the overlay. The `files:dropped` event is therefore also
    // the authoritative signal that the drop completed — reset the highlight
    // here so it can't stick after the files are staged.
    const unsub = onGlobalEvent('files:dropped', (data) => {
      if (!stagingActive) return
      if (!isFilesDroppedData(data)) return
      resetDrag()
      if (data.paths.length === 0) return
      void stageAttachmentPaths(activeSessionId, [...data.paths])
    })

    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', suppressNavigation)

    return () => {
      unsub()
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', suppressNavigation)
      // Reset the ref counter so a re-mount (e.g. mode switch back to chat)
      // starts from a clean state.
      dragEnterCount.current = 0
    }
  }, [mode, activeSessionId, stageAttachmentPaths, stageAttachmentFiles])

  return { dragActive }
}

/** A native drag carrying files exposes `files` on its dataTransfer (or
 *  `types` containing "Files"). Synthetic/drive-by drags (e.g. text) are
 *  ignored so the overlay only lights up for real file drops. */
function hasFiles(e: DragEvent): boolean {
  // dataTransfer can be null per spec for some synthetic events.
  const dt = e.dataTransfer
  if (!dt) return false
  if (dt.files && dt.files.length > 0) return true
  return Array.from(dt.types ?? []).includes('Files')
}
