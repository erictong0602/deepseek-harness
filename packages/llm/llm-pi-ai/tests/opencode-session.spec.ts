import { describe, expect, it } from 'vitest'
import { opencodeSessionHeaders } from '../src/adapter.ts'

/**
 * Console Go (opencode.ai) rejects requests without x-opencode-session
 * (400 MissingSessionID); the adapter supplies one per request. The helper
 * is protocol-neutral: it only decides whether the header is required.
 */
describe('opencode session header', () => {
  it('adds the harness session id on an opencode.ai endpoint', () => {
    const headers = opencodeSessionHeaders('https://opencode.ai/zen/go/v1', {}, 'session-abc')
    expect(headers['x-opencode-session']).toBe('session-abc')
  })

  it('adds a fresh id when the request names no session', () => {
    const headers = opencodeSessionHeaders('https://opencode.ai/zen/go/v1', {}, undefined)
    const session = headers['x-opencode-session']
    expect(typeof session).toBe('string')
    expect(session?.length ?? 0).toBeGreaterThan(0)
  })

  it('leaves endpoints outside the gateway untouched', () => {
    const headers = opencodeSessionHeaders('https://api.deepseek.com', { a: 'b' }, 'session-abc')
    expect(headers).toEqual({ a: 'b' })
    expect(headers['x-opencode-session']).toBeUndefined()
  })

  it('keeps an unparsable endpoint untouched', () => {
    const headers = opencodeSessionHeaders('not a url', {}, 'session-abc')
    expect(headers['x-opencode-session']).toBeUndefined()
  })

  it('respects a deployment-configured header of the same name', () => {
    const headers = opencodeSessionHeaders('https://opencode.ai/zen/go/v1', { 'x-opencode-session': 'static' }, 'session-abc')
    expect(headers['x-opencode-session']).toBe('static')
  })

  it('matches the configured header case-insensitively', () => {
    const headers = opencodeSessionHeaders('https://opencode.ai/zen/go/v1', { 'X-Opencode-Session': 'static' }, 'session-abc')
    expect(headers['X-Opencode-Session']).toBe('static')
    expect(headers['x-opencode-session']).toBeUndefined()
  })

  it('covers subdomains of the gateway', () => {
    const headers = opencodeSessionHeaders('https://api.opencode.ai/v1', {}, 'session-abc')
    expect(headers['x-opencode-session']).toBe('session-abc')
  })
})
