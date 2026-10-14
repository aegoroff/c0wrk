import { describe, it, expect } from 'vitest'

import { buildTabLabel } from './tabLabel'

describe('buildTabLabel', () => {
  it('joins scope and session with the window-title separator', () => {
    expect(buildTabLabel('Demo', 'Fix the bug')).toBe('Demo: Fix the bug')
  })

  it('renders the CHAT literal passed through by the scope selector', () => {
    expect(buildTabLabel('CHAT', 'Quick question')).toBe('CHAT: Quick question')
  })

  it('drops absent/blank segments instead of leaving dangling separators', () => {
    expect(buildTabLabel('Demo', null)).toBe('Demo')
    expect(buildTabLabel('Demo', '   ')).toBe('Demo')
    expect(buildTabLabel(null, 'Fix the bug')).toBe('Fix the bug')
    expect(buildTabLabel(null, null)).toBe('New Tab')
    expect(buildTabLabel('', '')).toBe('New Tab')
  })
})
