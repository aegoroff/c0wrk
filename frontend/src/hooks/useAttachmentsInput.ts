// Attach-files toolbar action: opens a file picker, then delegates the
// staging pipeline (vision gating, session-on-demand, attach + store sync) to
// useStageAttachments — the same pipeline used by drag-and-drop and
// paste-file. This hook stays a thin wrapper: pick → stage.
//
// Transport split (ADR-090): the Wails webview opens the NATIVE OS dialog
// (PickAttachmentFiles → absolute paths → stageAttachmentPaths); a browser
// tab has no native dialog, so it opens an ephemeral <input type="file"> and
// stages the File CONTENT through AttachFileContent (stageAttachmentFiles).
// Both branches share everything downstream of the pick.
//
// The pick call is wrapped in its own try/catch so a picker failure surfaces
// the app's existing runtime_error toast pattern; staging errors are handled
// inside the staging hooks.

import { useCallback } from 'react'
import { emit, isWebTransport } from '@/api/runtime'
import { pickAttachmentFiles } from '@/api/attachments'
import { openBrowserFilePicker } from '@/lib/browserFilePicker'
import { useStageAttachments } from '@/hooks/useStageAttachments'
import { logger } from '@/lib/logger'

/**
 * @param activeSessionId active chat session id (may be null).
 * @returns handleAttach() bound to the current session, creating one on demand.
 */
export function useAttachmentsInput(activeSessionId: string | null): {
  handleAttach: () => Promise<void>
} {
  const { stageAttachmentPaths, stageAttachmentFiles } = useStageAttachments()

  const handleAttach = useCallback(async () => {
    if (isWebTransport()) {
      // Web transport: the browser picker yields File objects whose content
      // travels through AttachFileContent — there are no absolute paths.
      try {
        const files = await openBrowserFilePicker()
        if (files.length === 0) return // user cancelled
        await stageAttachmentFiles(activeSessionId, files)
      } catch (err) {
        logger.error('Failed to attach files:', err)
        emit('runtime_error', {
          id: crypto.randomUUID(),
          message: 'Failed to attach files',
        })
      }
      return
    }

    try {
      const paths = await pickAttachmentFiles()
      if (!paths?.length) return // user cancelled

      await stageAttachmentPaths(activeSessionId, paths)
    } catch (err) {
      logger.error('Failed to attach files:', err)
      emit('runtime_error', {
        id: crypto.randomUUID(),
        message: 'Failed to attach files',
      })
    }
  }, [activeSessionId, stageAttachmentPaths, stageAttachmentFiles])

  return { handleAttach }
}
