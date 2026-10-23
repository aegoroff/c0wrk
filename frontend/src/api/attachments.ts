// File-attachment API wrappers.
//
// Wraps the generated Wails bindings (window.go.desktop.App) so components
// never import wailsjs directly. The backend's AttachmentInfo is SNAKE_CASE
// ({id, original_name, format, size_bytes}); we map it to a camelCase
// AttachmentInfoUI at this boundary so the rest of the app works with idiomatic
// TS field names.

import { getApp } from './runtime'
import { logger } from '@/lib/logger'
import { isArrayOf } from '@/types/guards'
import { isAttachmentInfoRaw, isPasteResultRaw } from '@/types/events'
import type { AttachmentInfoRaw, PasteResultRaw } from '@/types/events'
import type { AttachmentInfoUI, PasteResultUI } from '@/types/models'

/** Re-export the raw event type for backward compatibility */
export type { AttachmentInfoRaw, PasteResultRaw } from '@/types/events'

/** Map a single snake_case backend record to camelCase UI record.
 *  Image-only fields (`is_image`/`thumbnail`/`path`/`media_type`) are
 *  forwarded when present so the UI can render thumbnails and gate image-only
 *  affordances. */
export function mapAttachment(raw: AttachmentInfoRaw): AttachmentInfoUI {
  return {
    id: raw.id,
    originalName: raw.original_name,
    format: raw.format,
    sizeBytes: raw.size_bytes,
    isImage: raw.is_image,
    thumbnail: raw.thumbnail,
    path: raw.path,
    mediaType: raw.media_type,
  }
}

/** Map a list of snake_case backend records to camelCase UI records. */
export function mapAttachments(raw: readonly AttachmentInfoRaw[]): AttachmentInfoUI[] {
  return raw.map(mapAttachment)
}

/** Image extensions recognised by the backend's isImageFormat (png/jpg/jpeg/gif/webp).
 *  Used to pre-filter image files before attach when the selected model lacks
 *  vision capability. Mirrors backend/session/manager_attachment.go. */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

/** Report whether a file path has an image extension (png/jpg/jpeg/gif/webp).
 *  Mirrors the backend `isImageFormat` so the frontend can gate image uploads
 *  on model vision capability before staging. */
export function isImagePath(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return IMAGE_EXTENSIONS.has(ext)
}

/** Basename of a staged file path — the display label for picker and
 *  drag-and-drop upload placeholders. Mirrors the backend's `filepath.Base`
 *  fallback for AttachmentInfo.OriginalName, so it understands BOTH path
 *  separators: the backend runs on Windows too, where absolute paths arrive
 *  with backslashes. */
export function attachmentBaseName(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return idx === -1 ? path : path.slice(idx + 1)
}

/** Client-side mirror of the backend's maxAttachContentBytes (the raw
 *  attachment buffer cap the pipeline enforces). The wrapper rejects oversize
 *  payloads before encoding, so a too-big upload fails fast with a clear
 *  error instead of a 40×-inflated base64 round-trip. */
export const MAX_ATTACHMENT_UPLOAD_BYTES = 32 * 1024 * 1024

/** Encode bytes as a base64 string (the wire form of a Go []byte argument on
 *  both bridges). Chunked because `btoa`/`String.fromCharCode` blow the
 *  argument stack on large arrays; 0x8000 is the classic safe chunk size. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** An in-memory file staged from the web transport: a browser
 *  `<input type="file">` pick or an HTML5 drag-drop has no absolute path, so
 *  its content travels through AttachFileContent instead of AttachFiles. */
export interface AttachmentFileInput {
  /** The file's name as delivered by the browser (untrusted; the backend
   *  reduces it to a bare base name before staging). */
  name: string
  /** MIME type reported by the browser; fills in a missing image extension
   *  on the backend. */
  type: string
  /** Raw file bytes. */
  bytes: Uint8Array
}

/**
 * Stage an in-memory file as a pending attachment for a session via the
 * backend's AttachFileContent RPC — the web-transport upload path. The
 * backend runs the FULL AttachFiles pipeline (extension routing, image
 * limits, markitdown conversion with vision, storage, events), so the
 * returned list is identical to attachFiles' for the same content on disk.
 *
 * Rejects oversize payloads client-side (MAX_ATTACHMENT_UPLOAD_BYTES) and
 * maps the snake_case response exactly like attachFiles.
 *
 * Known divergence from the generated binding (CS #8): the Go parameter is
 * `[]byte`, so `App.d.ts` declares `data: Array<number>`, but this wrapper
 * sends a base64 STRING. It is deliberate and works on both bridges —
 * `encoding/json` accepts a base64 string for `[]byte` — but a caller going
 * through the typed signature directly would break; keep the divergence in
 * mind when touching the wire shape.
 */
export async function attachFileContent(sessionId: string, file: AttachmentFileInput): Promise<AttachmentInfoUI[]> {
  if (file.bytes.byteLength > MAX_ATTACHMENT_UPLOAD_BYTES) {
    throw new Error(
      `attachFileContent: ${file.name} is ${file.bytes.byteLength} bytes, ` +
        `above the ${MAX_ATTACHMENT_UPLOAD_BYTES} byte attachment limit`,
    )
  }
  try {
    const app = getApp()
    const result = await app.AttachFileContent(sessionId, file.name, file.type, bytesToBase64(file.bytes))
    if (!isArrayOf(result, isAttachmentInfoRaw)) {
      logger.error('attachFileContent: unexpected response shape, returning []', result)
      return []
    }
    return mapAttachments(result)
  } catch (err) {
    logger.error('Failed to attach file content:', err)
    throw err
  }
}

/**
 * Open the native file picker for attachment selection.
 * Returns the chosen absolute paths (empty if the user cancelled).
 */
export async function pickAttachmentFiles(): Promise<string[]> {
  try {
    const app = getApp()
    const result = await app.PickAttachmentFiles()
    if (!Array.isArray(result)) {
      throw new Error('pickAttachmentFiles: backend returned non-array data')
    }
    return result.filter((p: unknown): p is string => typeof p === 'string')
  } catch (err) {
    logger.error('Failed to pick attachment files:', err)
    throw err
  }
}

/**
 * Stage files as pending attachments for a session.
 * The backend returns the FULL current pending-attachment list; we map it to
 * UI records so the caller can replace its store in one shot.
 */
export async function attachFiles(sessionId: string, paths: string[]): Promise<AttachmentInfoUI[]> {
  try {
    const app = getApp()
    const result = await app.AttachFiles(sessionId, paths)
    if (!isArrayOf(result, isAttachmentInfoRaw)) {
      logger.error('attachFiles: unexpected response shape, returning []', result)
      return []
    }
    return mapAttachments(result)
  } catch (err) {
    logger.error('Failed to attach files:', err)
    throw err
  }
}

/** Remove a single pending attachment by id. */
export async function removeAttachment(sessionId: string, attachmentId: string): Promise<void> {
  try {
    const app = getApp()
    await app.RemoveAttachment(sessionId, attachmentId)
  } catch (err) {
    logger.error('Failed to remove attachment:', err)
    throw err
  }
}

/** Fetch the full current pending-attachment list for a session. */
export async function getAttachments(sessionId: string): Promise<AttachmentInfoUI[]> {
  try {
    const app = getApp()
    const result = await app.GetAttachments(sessionId)
    if (!isArrayOf(result, isAttachmentInfoRaw)) {
      logger.error('getAttachments: unexpected response shape, returning []', result)
      return []
    }
    return mapAttachments(result)
  } catch (err) {
    logger.error('Failed to get attachments:', err)
    throw err
  }
}

/**
 * Fetch the converted markdown content of a committed blackboard attachment.
 * Used when the user opens an attachment in the file viewer. Returns the raw
 * markdown string produced by markitdown.
 */
export async function getBlackboardAttachmentMarkdown(sessionId: string, attachmentId: string): Promise<string> {
  try {
    const app = getApp()
    const result = await app.GetBlackboardAttachmentMarkdown(sessionId, attachmentId)
    if (typeof result !== 'string') {
      throw new Error('getBlackboardAttachmentMarkdown: backend returned non-string data')
    }
    return result
  } catch (err) {
    logger.error('Failed to get blackboard attachment markdown:', err)
    throw err
  }
}

/**
 * Probe the system clipboard and stage the highest-priority content found
 * (image → files → text) as a pending attachment on the session. Wraps the
 * backend PasteFromClipboard RPC.
 *
 * `supportsVision` reflects the active model's image-input capability and
 * gates image staging on the backend side. The discriminant `kind` in the
 * result tells the caller how to react: render an image/file chip (kind=image
 * with accepted files, or kind=files), surface a rejection (kind=image with
 * `rejected`), or insert text into the chat input (kind=text).
 *
 * On an unexpected response shape we return an `empty` result (logging the
 * anomaly) rather than throwing, so a malformed backend reply never crashes
 * a paste — the user simply sees nothing happen.
 */
export async function pasteFromClipboard(sessionId: string, supportsVision: boolean): Promise<PasteResultUI> {
  try {
    const app = getApp()
    const result = await app.PasteFromClipboard(sessionId, supportsVision)
    if (!isPasteResultRaw(result)) {
      logger.error('pasteFromClipboard: unexpected response shape, returning empty', result)
      return { kind: 'empty', files: [] }
    }
    return mapPasteResult(result)
  } catch (err) {
    logger.error('Failed to paste from clipboard:', err)
    throw err
  }
}

/** Map a snake_case backend PasteResult to the camelCase UI shape.
 *  `files` defaults to an empty array so the UI can branch on `kind` without
 *  a null check. */
export function mapPasteResult(raw: PasteResultRaw): PasteResultUI {
  return {
    kind: raw.kind,
    text: raw.text,
    files: raw.files ? mapAttachments(raw.files) : [],
    rejected: raw.rejected,
    skippedImages: raw.skipped_images,
  }
}
