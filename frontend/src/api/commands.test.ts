import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { listCommands } from './commands'
import { logger } from '@/lib/logger'

const getAppMock = vi.fn()

vi.mock('./runtime', () => ({
  getApp: () => getAppMock(),
}))

function appWith(result: unknown, error?: unknown) {
  return {
    ListCommands: vi.fn().mockImplementation(() => (error ? Promise.reject(error) : Promise.resolve(result))),
  }
}

describe('listCommands', () => {
  beforeEach(() => {
    getAppMock.mockReset()
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
    vi.spyOn(logger, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes a fully valid catalog through', async () => {
    const app = appWith([
      { name: 'deploy', description: 'Deploy', agent: 'reviewer', model: 'gpt-x', template: 'Deploy $ARGUMENTS' },
      { name: 'review', description: '', agent: '', model: '', template: 'Review.' },
    ])
    getAppMock.mockReturnValue(app)
    await expect(listCommands()).resolves.toHaveLength(2)
    expect(app.ListCommands).toHaveBeenCalledTimes(1)
  })

  it('degrades to [] when one element is malformed', async () => {
    getAppMock.mockReturnValue(appWith([
      { name: 'ok', description: 'd', agent: '', model: '', template: 't' },
      { name: 42, description: 'd', agent: '', model: '', template: 't' },
    ]))
    await expect(listCommands()).resolves.toEqual([])
    expect(logger.warn).toHaveBeenCalledWith('listCommands: unexpected response shape', expect.anything())
  })

  it('degrades to [] on a non-array response', async () => {
    getAppMock.mockReturnValue(appWith({ name: 'deploy' }))
    await expect(listCommands()).resolves.toEqual([])
  })

  it('rethrows RPC failures for the caller to degrade', async () => {
    getAppMock.mockReturnValue(appWith(undefined, new Error('rpc down')))
    await expect(listCommands()).rejects.toThrow('rpc down')
    expect(logger.error).toHaveBeenCalled()
  })
})
