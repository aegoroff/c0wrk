// Reusable attachment-staging pipeline shared by every entry point that turns
// a list of file paths into pending attachments: the 📎 picker
// (useAttachmentsInput), drag-and-drop, and paste-file.
//
// Encapsulates the three concerns that were previously inlined in
// useAttachmentsInput.handleAttach:
//   1. Vision gating — when the effective model lacks vision capability,
//      image files (png/jpg/jpeg/gif/webp) are filtered out before staging and
//      a dismissible error banner is surfaced via the attachmentsStore.
//      Documents are staged regardless of model capability.
//   2. Session-on-demand — when no active session exists yet, one is created
//      (mirroring terminal-mode auto-create) before staging.
//   3. Staging + store sync — attachFiles stages the paths and returns the FULL
//      current pending list; we push it into the store in one shot.
//
// Every store write is keyed to the session captured at stage time (the
// caller's activeSessionId, or the session created on demand) — NEVER to the
// currently-visible session. The attachFiles round-trip can straddle a
// session switch; its result must land in the session the user staged into.
//
// The picker (native file dialog) stays in useAttachmentsInput; only the
// post-pick staging logic lives here so drop/paste can reuse it verbatim.

import { useCallback } from 'react'
import { emit } from '@/api/runtime'
import { attachFileContent, attachFiles, attachmentBaseName, isImagePath, MAX_ATTACHMENT_UPLOAD_BYTES } from '@/api/attachments'
import type { AttachmentInfoUI } from '@/types/models'
import {
  beginAttachmentUploadsFresh,
  completeAttachmentUploads,
  failAttachmentUploads,
} from '@/lib/attachmentUploads'
import { ensureActiveSession } from '@/lib/ensureActiveSession'
import { useAttachmentsStore } from '@/stores/attachmentsStore'
import { useSessionStore } from '@/stores/sessionStore'
import { NULL_SESSION_KEY } from '@/stores/chatInputStore'
import { useInputModeStore } from '@/stores/inputModeStore'
import { useConfigData } from '@/hooks/useConfigData'
import { resolveModelContext, visionRejectionMessage } from '@/lib/vision'
import { logger } from '@/lib/logger'
import { generateUUID } from '@/lib/ids'

/** One file to stage, transport-shaped: native entry points keep their
 *  absolute path; web content uploads carry the name only (path='') — the
 *  same shape attachmentUploads already uses for name-only placeholders. */
interface StageEntry {
  path: string
  fileName: string
  isImage: boolean
}

/** The transport-specific staging RPC: given the (possibly just-created)
 *  session and the stageable entries, returns the FULL current pending list
 *  (already mapped to UI records) — the contract both attachFiles and a
 *  completed AttachFileContent loop honor. */
type StageRpc = (sessionId: string, entries: StageEntry[]) => Promise<AttachmentInfoUI[]>

/**
 * Reusable attachment-staging hook.
 *
 * @returns stageAttachmentPaths() bound to the effective model's vision
 *   capability (native entry points: absolute paths) and
 *   stageAttachmentFiles() (web entry points: in-memory File objects staged
 *   through AttachFileContent). Both share one pipeline.
 */
export function useStageAttachments(): {
  stageAttachmentPaths: (activeSessionId: string | null, paths: string[]) => Promise<void>
  stageAttachmentFiles: (activeSessionId: string | null, files: readonly File[]) => Promise<void>
} {
  const selectedModel = useInputModeStore((s) => s.selectedModel)
  const { allModels, defaultModel } = useConfigData()

  const stageEntries = useCallback(
    async (activeSessionId: string | null, entries: StageEntry[], rpc: StageRpc): Promise<void> => {
      try {
        // Resolve the effective model's vision capability. selectedModel is a
        // per-message override (composite "provider/name" or null = global
        // default_model); findModelInfo handles both forms.
        const { effectiveModel, modelInfo } = resolveModelContext(allModels, selectedModel, defaultModel)
        const supportsVision = modelInfo?.vision ?? false

        // When the model lacks vision, images are rejected (banner shown) and
        // only documents are staged.
        const imageEntries = entries.filter((e) => e.isImage)
        const docEntries = entries.filter((e) => !e.isImage)

        const visionRejected = imageEntries.length > 0 && !supportsVision
        if (visionRejected && docEntries.length === 0) {
          // Nothing stageable: surface the rejection without creating a
          // session. With no active session the banner is keyed under the
          // NULL_SESSION_KEY sentinel so it still renders in the input.
          useAttachmentsStore
            .getState()
            .setImageError(
              activeSessionId ?? NULL_SESSION_KEY,
              visionRejectionMessage(effectiveModel, modelInfo),
            )
          return
        }

        // Ensure a session exists — terminal mode does the same on demand.
        // Staging never creates a worktree: the fallback is a plain LOCAL
        // session (ADR-091), and the normal path already has one (the eager
        // "New Session" row). Captured BEFORE the awaits below: if the user
        // switches sessions while attachFiles is in flight, the result still
        // lands in this (origin) session's key.
        let sessionId = activeSessionId
        if (!sessionId) {
          const newSession = await ensureActiveSession()
          sessionId = newSession.id
        }

        if (visionRejected) {
          useAttachmentsStore
            .getState()
            .setImageError(sessionId, visionRejectionMessage(effectiveModel, modelInfo))
        } else {
          // Clear any stale error from a previous attempt.
          useAttachmentsStore.getState().setImageError(sessionId, null)
        }

        const toAttach = supportsVision ? entries : docEntries

        // Optimistic upload placeholders: spinner chips appear and drain as
        // the backend's incremental `attachments:changed` events land
        // matching attachments (or when the RPC settles). Uploads cancelled
        // via their chip's X are stripped here and removed from the backend.
        // The fresh-baseline variant unions the backend's authoritative
        // pending list into the claim window first so a stale store slice
        // cannot shrink it.
        const uploads = await beginAttachmentUploadsFresh(
          sessionId,
          toAttach.map((e) => ({
            path: e.path,
            fileName: e.fileName,
            isImage: e.isImage,
          })),
        )
        try {
          // The staging RPC returns the FULL current pending list (already
          // mapped) — one shot for the native path, the final result of the
          // per-file loop for web content.
          const list = await rpc(sessionId, toAttach)
          const kept = completeAttachmentUploads(sessionId, uploads, list)
          useAttachmentsStore.getState().setAttachments(sessionId, kept)
        } catch (err) {
          failAttachmentUploads(uploads)
          throw err
        }
      } catch (err) {
        logger.error('Failed to attach files:', err)
        emit('runtime_error', {
          id: generateUUID(),
          message: 'Failed to attach files',
        })
      }
    },
    [selectedModel, allModels, defaultModel],
  )

  const stageAttachmentPaths = useCallback(
    async (activeSessionId: string | null, paths: string[]): Promise<void> => {
      await stageEntries(
        activeSessionId,
        paths.map((p) => ({ path: p, fileName: attachmentBaseName(p), isImage: isImagePath(p) })),
        (sessionId, entries) => attachFiles(sessionId, entries.map((e) => e.path)),
      )
    },
    [stageEntries],
  )

  const stageAttachmentFiles = useCallback(
    async (activeSessionId: string | null, files: readonly File[]): Promise<void> => {
      if (files.length === 0) return
      // Size-cap BEFORE any byte read (CS #34): attachFileContent's identical
      // check only runs after the file is already materialized as bytes, so a
      // multi-GB drop used to cost a gigabyte-scale tab allocation (possible
      // OOM) before the clean rejection. `file.size` is free metadata —
      // oversize files are rejected here through the same attachment-error
      // banner the vision gate uses, and only within-cap files are staged.
      const oversize = files.filter((f) => f.size > MAX_ATTACHMENT_UPLOAD_BYTES)
      const oversizeMessage =
        oversize.length === 0
          ? null
          : oversize.length === 1
            ? `${oversize[0]!.name} is above the ${MAX_ATTACHMENT_UPLOAD_BYTES} byte attachment limit`
            : `${oversize.length} files are above the ${MAX_ATTACHMENT_UPLOAD_BYTES} byte attachment limit: ${oversize.map((f) => f.name).join(', ')}`
      const stageable =
        oversizeMessage === null ? files : files.filter((f) => f.size <= MAX_ATTACHMENT_UPLOAD_BYTES)
      if (oversizeMessage !== null && stageable.length === 0) {
        // Nothing stageable: reject without creating a session — the same
        // banner path the vision gate uses for a nothing-stageable drop.
        useAttachmentsStore.getState().setImageError(activeSessionId ?? NULL_SESSION_KEY, oversizeMessage)
        return
      }
      // Zip by identity, not by name: a web drop may carry two files with the
      // same basename (multi-select across folders), and a name-keyed map
      // would stage one file's BYTES under the other's name. The entry
      // objects flow through stageEntries by reference, so the closure
      // resolves each entry back to its own File; the name is display-only
      // metadata.
      const staged = stageable.map((file) => ({
        entry: { path: '', fileName: file.name, isImage: isImagePath(file.name) },
        file,
      }))
      await stageEntries(
        activeSessionId,
        staged.map((s) => s.entry),
        async (sessionId, entries) => {
          // Web content has no path: each file is uploaded through
          // AttachFileContent. Every call returns the FULL current pending
          // list, so the last successful result is the authoritative store
          // value; a mid-loop failure drains the placeholders exactly like a
          // failed attachFiles call (already-staged files stay staged).
          const fileByEntry = new Map<StageEntry, File>(staged.map((s) => [s.entry, s.file] as const))
          let list: AttachmentInfoUI[] = []
          for (const e of entries) {
            const file = fileByEntry.get(e)
            if (!file) continue
            list = await attachFileContent(sessionId, {
              name: file.name,
              type: file.type,
              bytes: new Uint8Array(await file.arrayBuffer()),
            })
          }
          return list
        },
      )
      if (oversizeMessage !== null) {
        // stageEntries' non-rejected path clears the banner on success;
        // re-assert the oversize notice under the key staging landed in —
        // the caller's session, or the on-demand created session (which
        // ensureActiveSession left active and visible).
        const bannerKey =
          activeSessionId ?? useSessionStore.getState().activeSessionId ?? NULL_SESSION_KEY
        useAttachmentsStore.getState().setImageError(bannerKey, oversizeMessage)
      }
    },
    [stageEntries],
  )

  return { stageAttachmentPaths, stageAttachmentFiles }
}
