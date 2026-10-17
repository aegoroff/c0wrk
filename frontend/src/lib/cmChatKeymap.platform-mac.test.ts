// @vitest-environment jsdom
// Chat keymap integration against a REAL macOS (MacIntel) CodeMirror keymap.
//
// navigator.platform is pinned inside vi.hoisted, which vitest runs BEFORE
// the static imports below evaluate. CodeMirror resolves its platform exactly
// once — at @codemirror/view module load — and bakes it into its
// named-binding tables (on mac: Mod-y redo replaced by Cmd+Shift+Z), so the
// platform must be set before the first editor import; a spy in a test body
// would only affect our own per-call matcher. See
// cmChatKeymapPlatformHarness.ts for the shared suite and the layer model.
import { vi } from 'vitest'

vi.hoisted(() => {
  Object.defineProperty(navigator, 'platform', {
    value: 'MacIntel',
    configurable: true,
  })
})

import { runChatKeymapPlatformSuite } from './cmChatKeymapPlatformHarness'

runChatKeymapPlatformSuite({ label: 'macOS (MacIntel)', useMeta: true, mod: 'Cmd' })
