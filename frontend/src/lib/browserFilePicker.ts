// Browser file picker for the web transport: the native OS dialog
// (PickAttachmentFiles) does not exist in a browser tab, so the attachment
// input opens an ephemeral <input type="file"> instead and hands the chosen
// File objects (content, not paths) to the staging pipeline.

/** Options for openBrowserFilePicker. */
interface BrowserFilePickerOptions {
  /** Allow selecting more than one file (attachments default to true). */
  multiple?: boolean
  /** Restrict the picker's accepted types (a comma list of extensions/MIME
   *  types, e.g. ".css,.scss"). Omitted for attachments (accept anything). */
  accept?: string
}

/**
 * Open a browser file picker and resolve with the chosen files (empty when
 * the user cancelled). One-shot: the input element is removed after the
 * gesture completes, whether a change or a cancel event arrives.
 *
 * The cancel event is part of the HTML spec but is not delivered by every
 * engine; the promise therefore also settles via change-or-cancel — whichever
 * fires first wins. A one-shot window `focus` listener backs both up: the
 * focus that follows the dialog closing (a dismissed picker on an engine
 * without cancel support, or a pick whose change event was lost) settles the
 * promise and removes the dead hidden input from `<body>` instead of
 * leaking one per dismissal. Only a dialog that never closes leaves the
 * promise pending, exactly like an abandoned native dialog blocks the
 * native flow.
 */
export function openBrowserFilePicker(options: BrowserFilePickerOptions = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = options.multiple ?? true
    if (options.accept) input.accept = options.accept
    input.style.display = 'none'

    let settled = false
    const finish = (files: File[]) => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onWindowFocus)
      input.remove()
      resolve(files)
    }
    // The focus fallback runs AFTER change/cancel on conforming engines
    // (settled already true → no-op); on cancel-less engines it is the only
    // finish path for a dismissed picker.
    const onWindowFocus = () => finish(Array.from(input.files ?? []))

    input.addEventListener('change', () => finish(Array.from(input.files ?? [])))
    input.addEventListener('cancel', () => finish([]))

    document.body.appendChild(input)
    input.click()
    window.addEventListener('focus', onWindowFocus, { once: true })
  })
}
