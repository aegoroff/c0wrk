// @vitest-environment jsdom
// Chat keymap integration against a REAL Windows (Win32) CodeMirror keymap.
//
// navigator.platform is pinned inside vi.hoisted, which vitest runs BEFORE
// the static imports below evaluate. CodeMirror resolves its platform exactly
// once — at @codemirror/view module load — and bakes it into its
// named-binding tables (on Windows: Mod-y redo registered directly, no
// standalone Mod-Shift-z), so the platform must be set before the first
// editor import; a spy in a test body would only affect our own per-call
// matcher. See cmChatKeymapPlatformHarness.ts for the shared suite and the
// layer model.
import { vi } from 'vitest'

vi.hoisted(() => {
  Object.defineProperty(navigator, 'platform', {
    value: 'Win32',
    configurable: true,
  })
})

import { runChatKeymapPlatformSuite } from './cmChatKeymapPlatformHarness'

runChatKeymapPlatformSuite({ label: 'Windows (Win32)', useMeta: false, mod: 'Ctrl' })
