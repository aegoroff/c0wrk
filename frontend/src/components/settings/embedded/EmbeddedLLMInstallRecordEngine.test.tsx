// @vitest-environment jsdom
//
// The engine line and the MTPLX attribution of the embedded-LLM install
// record. The attribution is a LICENSE obligation (MTPLX NOTICE, Apache-2.0
// §4(d)): a product built on MTPLX says so inside the product. It renders when
// — and only when — the engine on disk is mtplx; the llama family carries no
// such obligation and must not show the line.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import type { EmbeddedLLMStatus } from '@/api/embedded'
import { EmbeddedLLMInstallRecord } from './EmbeddedLLMInstallRecord'
import { makeEmbeddedStatus } from '@/test/embeddedStatusFixture'

function withEngine(engine: string): EmbeddedLLMStatus {
  return {
    ...makeEmbeddedStatus(),
    installed: true,
    engine,
    runtime_version: engine === 'mtplx' ? '2.12.2' : 'prism-b10735-842b188',
  }
}

let container: HTMLElement | null = null
let root: Root | null = null

async function render(status: EmbeddedLLMStatus): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<EmbeddedLLMInstallRecord status={status} />)
  })
}

function testId(id: string): HTMLElement | null {
  return container?.querySelector(`[data-testid="${id}"]`) ?? null
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  container?.remove()
  container = null
  root = null
})

describe('the install record engine line', () => {
  it('renders MLX (MTPLX) for the mtplx engine', async () => {
    await render(withEngine('mtplx'))
    expect(testId('embedded-llm-engine')?.textContent).toBe('MLX (MTPLX)')
  })

  it('renders llama.cpp for the llama engine', async () => {
    await render(withEngine('llama'))
    expect(testId('embedded-llm-engine')?.textContent).toBe('llama.cpp')
  })

  it('renders llama.cpp for a pre-engine (empty) record', async () => {
    await render(withEngine(''))
    expect(testId('embedded-llm-engine')?.textContent).toBe('llama.cpp')
  })
})

describe('the MTPLX attribution line', () => {
  it('renders on an mtplx install, naming MTPLX and linking the project', async () => {
    await render(withEngine('mtplx'))
    const line = testId('embedded-llm-attribution')
    expect(line?.textContent).toContain('Powered by MTPLX')
    const link = line?.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://github.com/youssofal/MTPLX')
  })

  it('does not render on a llama install', async () => {
    await render(withEngine('llama'))
    expect(testId('embedded-llm-attribution')).toBeNull()
  })

  it('does not render on a pre-engine record', async () => {
    await render(withEngine(''))
    expect(testId('embedded-llm-attribution')).toBeNull()
  })
})
