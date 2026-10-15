// @vitest-environment jsdom
// Chat keymap integration against a REAL Linux (X11) CodeMirror keymap.
//
// navigator.platform is pinned inside vi.hoisted, which vitest runs BEFORE
// the static imports below evaluate. CodeMirror resolves its platform exactly
// once — at @codemirror/view module load — and bakes it into its
// named-binding tables (on Linux the standalone Mod-Shift-z redo binding is
// registered, alongside Mod-y), so the platform must be set before the first
// editor import; a spy in a test body would only affect our own per-call
// matcher. This suite also documents the behavior the platform-agnostic
// cmChatKeymap.test.ts exercises implicitly: jsdom's empty platform selects
// the linux binding table. See cmChatKeymapPlatformHarness.ts for the shared
// suite and the layer model.
import { vi } from 'vitest'

vi.hoisted(() => {
  Object.defineProperty(navigator, 'platform', {
    value: 'Linux x86_64',
    configurable: true,
  })
})

import { runChatKeymapPlatformSuite } from './cmChatKeymapPlatformHarness'

runChatKeymapPlatformSuite({ label: 'Linux (X11)', useMeta: false, mod: 'Ctrl' })
