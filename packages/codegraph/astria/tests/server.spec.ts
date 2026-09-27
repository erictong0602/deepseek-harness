import { describe, expect, it } from 'vitest'
import type { CodeGraphQueryRequest } from '@deepseek-ai/dsh-codegraph'
import { AstriaMcpServer, mcpToolCall } from '@deepseek-ai/dsh-astria'
import type { AstriaServerSpec } from '@deepseek-ai/dsh-astria'
import { Writable } from 'node:stream'
import { FakeMcpChild } from './helpers.ts'

const serverSpec: AstriaServerSpec = {
  executable: '/bin/astria',
  args: ['--global'],
  env: { ASTRIA_EXTRA: '1' },
  callTimeoutMs: 500,
  killGraceMs: 250,
  maxStderrBytes: 200,
}

describe('mcpToolCall', () => {
  it('maps every seam operation onto the server tool vocabulary', () => {
    const request = (query: CodeGraphQueryRequest['query']): CodeGraphQueryRequest => ({ root: '/ws', query })
    expect(mcpToolCall(request({ operation: 'repoMap', budgetTokens: 400 })))
      .toEqual({ name: 'repo_map', arguments: { budget: 400 } })
    expect(mcpToolCall(request({ operation: 'query', question: 'auth', depth: 3, directed: true, budgetTokens: 90 })))
      .toEqual({ name: 'query_graph', arguments: { question: 'auth', depth: 3, directed: true, budget: 90 } })
    expect(mcpToolCall(request({ operation: 'query', question: 'auth' })))
      .toEqual({ name: 'query_graph', arguments: { question: 'auth' } })
    expect(mcpToolCall(request({ operation: 'query', question: 'wide', cursor: 9 })))
      .toEqual({ name: 'query_graph', arguments: { question: 'wide', cursor: 9 } })
    expect(mcpToolCall(request({ operation: 'explain', node: 'Lsp' })))
      .toEqual({ name: 'explain', arguments: { node: 'Lsp' } })
    expect(mcpToolCall(request({ operation: 'path', source: 'a', target: 'b', directed: true })))
      .toEqual({ name: 'shortest_path', arguments: { source: 'a', target: 'b', directed: true } })
    expect(mcpToolCall(request({ operation: 'path', source: 'a', target: 'b' })))
      .toEqual({ name: 'shortest_path', arguments: { source: 'a', target: 'b' } })
    expect(mcpToolCall(request({ operation: 'affected', node: 'X', depth: 4 })))
      .toEqual({ name: 'affected', arguments: { node: 'X', depth: 4 } })
    expect(mcpToolCall(request({ operation: 'affected', node: 'X' })))
      .toEqual({ name: 'affected', arguments: { node: 'X' } })
    expect(mcpToolCall(request({ operation: 'stats' })))
      .toEqual({ name: 'graph_stats', arguments: {} })
  })
})

/** Resolve the id of the most recent tools/call once it has been written. */
async function lastCallId(child: FakeMcpChild): Promise<number> {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    const call = [...child.received].reverse().find(message => message.method === 'tools/call')
    if (call?.id !== undefined) return call.id
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('tools/call was never written')
}

describe('AstriaMcpServer', () => {
  it('handshakes on start, answers calls with joined text, and pins the graph root', async () => {
    const child = new FakeMcpChild((message) => {
      if (message.id === undefined) return
      if (message.method === 'initialize') child.reply(message.id, { capabilities: { tools: {} } })
      if (message.method === 'tools/call') {
        child.reply(message.id, { content: [{ type: 'text', text: 'node alpha' }, { type: 'text', text: 'node beta' }], isError: false })
      }
    })
    const spawned: (readonly string[])[] = []
    const server = await AstriaMcpServer.start((spec) => {
      spawned.push(spec.argv)
      return child.handle()
    }, serverSpec, '/ws')
    expect(spawned[0]).toEqual(['/bin/astria', '--global', 'mcp', '--graph', '/ws'])
    expect(child.received[0]).toMatchObject({ method: 'initialize' })
    expect(child.received[1]).toMatchObject({ method: 'notifications/initialized' })
    await expect(server.call({ name: 'graph_stats', arguments: {} }, 'stats')).resolves.toEqual({ kind: 'text', text: 'node alpha\nnode beta', truncated: false })
    await server.dispose()
  })

  it('fails an isError call as CODEGRAPH_EXIT carrying the text', async () => {
    const child = new FakeMcpChild((message) => {
      if (message.id === undefined) return
      child.reply(message.id, message.method === 'initialize'
        ? { capabilities: {} }
        : { content: [{ type: 'text', text: 'extract failed' }], isError: true })
    })
    const server = await AstriaMcpServer.start(() => child.handle(), serverSpec, '/ws')
    await expect(server.call({ name: 'repo_map', arguments: {} }, 'repoMap')).rejects.toThrow(/extract failed/)
    await server.dispose()
  })

  it('answers server-initiated requests with method-not-found and drops notifications', async () => {
    const child = new FakeMcpChild((message) => {
      if (message.id !== undefined && message.method === 'initialize') child.reply(message.id, { capabilities: {} })
    })
    const server = await AstriaMcpServer.start(() => child.handle(), serverSpec, '/ws')
    child.send({ jsonrpc: '2.0', method: 'notifications/telemetry', params: {} })
    child.send({ jsonrpc: '2.0', id: 900, method: 'sampling/createMessage' })
    const pending = server.call({ name: 'graph_stats', arguments: {} }, 'stats')
    const callId = await lastCallId(child)
    child.send({ jsonrpc: '2.0', id: callId, result: { content: [{ type: 'text', text: 'ok' }] } })
    await expect(pending).resolves.toMatchObject({ text: 'ok' })
    expect(JSON.stringify(child.received)).toContain('-32601')
    await server.dispose()
  })

  it('drops malformed stdout lines without breaking the pipeline', async () => {
    const child = new FakeMcpChild((message) => {
      if (message.id !== undefined && message.method === 'initialize') child.reply(message.id, { capabilities: {} })
    })
    const server = await AstriaMcpServer.start(() => child.handle(), serverSpec, '/ws')
    child.stdout.write('\n')
    child.stdout.write('this is not json\n')
    const pending = server.call({ name: 'graph_stats', arguments: {} }, 'stats')
    const callId = await lastCallId(child)
    child.send({ jsonrpc: '2.0', id: callId, result: { content: [{ type: 'text', text: 'still alive' }] } })
    await expect(pending).resolves.toMatchObject({ text: 'still alive' })
    await server.dispose()
  })

  it('rejects a call that outlives its budget and retires the server', async () => {
    const slow = new FakeMcpChild((message) => {
      if (message.id === undefined) return
      if (message.method === 'initialize') slow.reply(message.id, { capabilities: {} })
      // tools/call never answers.
    })
    const server = await AstriaMcpServer.start(() => slow.handle(), { ...serverSpec, callTimeoutMs: 40 }, '/ws')
    await expect(server.call({ name: 'graph_stats', arguments: {} }, 'stats')).rejects.toThrow(/timed out after 40ms/)
    expect(server.dead).toBe(true)
    await expect(server.call({ name: 'graph_stats', arguments: {} }, 'stats')).rejects.toThrow(/closed/)
  })

  it('rejects pending calls when the transport exits unexpectedly', async () => {
    const child = new FakeMcpChild((message) => {
      if (message.id === undefined) return
      if (message.method === 'initialize') child.reply(message.id, { capabilities: {} })
      if (message.method === 'tools/call') child.close()
    })
    const server = await AstriaMcpServer.start(() => child.handle(), serverSpec, '/ws')
    await expect(server.call({ name: 'graph_stats', arguments: {} }, 'stats')).rejects.toThrow(/exited unexpectedly|closed/)
    expect(server.dead).toBe(true)
  })

  it('fails start when initialization is rejected and terminates the child', async () => {
    const child = new FakeMcpChild((message) => {
      if (message.id === undefined) return
      child.fail(message.id, { code: -32000, message: 'bad graph' })
    })
    await expect(AstriaMcpServer.start(() => child.handle(), serverSpec, '/ws')).rejects.toThrow(/bad graph/)
    expect(child.wasTerminated).toBe(true)
  })

  it('closes the transport when the stdout stream errors', async () => {
    const child = new FakeMcpChild((message) => {
      if (message.id !== undefined && message.method === 'initialize') child.reply(message.id, { capabilities: {} })
    })
    const server = await AstriaMcpServer.start(() => child.handle(), serverSpec, '/ws')
    const pending = server.call({ name: 'graph_stats', arguments: {} }, 'stats')
    child.stdout.emit('error', new Error('pipe broke'))
    await expect(pending).rejects.toThrow(/exited unexpectedly|closed/)
    await new Promise(resolve => setImmediate(resolve))
    expect(server.dead).toBe(true)
  })

  it('settles the transport on stdout end', async () => {
    const child = new FakeMcpChild((message) => {
      if (message.id === undefined) return
      if (message.method === 'initialize') child.reply(message.id, { capabilities: {} })
    })
    const server = await AstriaMcpServer.start(() => child.handle(), serverSpec, '/ws')
    const pending = server.call({ name: 'graph_stats', arguments: {} }, 'stats')
    await new Promise<void>((resolve) => {
      child.stdout.once('close', resolve)
      child.stdout.end()
    })
    await new Promise(resolve => setImmediate(resolve))
    await expect(pending).rejects.toThrow(/exited unexpectedly|closed/)
    expect(server.dead).toBe(true)
  })

  it('maps the missing-graph failure to CODEGRAPH_NO_GRAPH', async () => {
    const child = new FakeMcpChild((message) => {
      if (message.id === undefined) return
      child.reply(message.id, message.method === 'initialize'
        ? { capabilities: {} }
        : { content: [{ type: 'text', text: 'No graph found at .astria/db.sqlite' }], isError: true })
    })
    const server = await AstriaMcpServer.start(() => child.handle(), serverSpec, '/ws')
    await expect(server.call({ name: 'repo_map', arguments: {} }, 'repoMap')).rejects.toThrow(expect.objectContaining({ code: 'CODEGRAPH_NO_GRAPH' }))
    await server.dispose()
  })

  it('answers a contentless result with empty text', async () => {
    const child = new FakeMcpChild((message) => {
      if (message.id === undefined) return
      child.reply(message.id, message.method === 'initialize' ? { capabilities: {} } : {})
    })
    const server = await AstriaMcpServer.start(() => child.handle(), serverSpec, '/ws')
    await expect(server.call({ name: 'graph_stats', arguments: {} }, 'stats')).resolves.toEqual({ kind: 'text', text: '', truncated: false })
    await server.dispose()
  })

  it('fails start when writing to stdin throws', async () => {
    const child = new FakeMcpChild((message) => {
      if (message.id !== undefined && message.method === 'initialize') child.reply(message.id, { capabilities: {} })
    })
    const handle = child.handle()
    const broken = {
      ...handle,
      stdin: {
        write() { throw new Error('stdin closed') },
        end() {}, // inert
      } as unknown as Writable,
    }
    await expect(AstriaMcpServer.start(() => broken, serverSpec, '/ws')).rejects.toThrow()
  })

  it('ignores stray responses for unknown ids', async () => {
    const child = new FakeMcpChild((message) => {
      if (message.id === undefined) return
      child.reply(message.id, message.method === 'initialize' ? { capabilities: {} } : { content: [{ type: 'text', text: 'real' }] })
    })
    const server = await AstriaMcpServer.start(() => child.handle(), serverSpec, '/ws')
    child.send({ jsonrpc: '2.0', id: 999, result: { content: [] } })
    const pending = server.call({ name: 'graph_stats', arguments: {} }, 'stats')
    const callId = await lastCallId(child)
    child.send({ jsonrpc: '2.0', id: callId, result: { content: [{ type: 'text', text: 'real' }] } })
    await expect(pending).resolves.toMatchObject({ text: 'real' })
    await server.dispose()
  })

  it('rejects an outstanding call as closed when disposal wins the race', async () => {
    const child = new FakeMcpChild((message) => {
      if (message.id !== undefined && message.method === 'initialize') child.reply(message.id, { capabilities: {} })
    })
    const server = await AstriaMcpServer.start(() => child.handle(), serverSpec, '/ws')
    const pending = server.call({ name: 'graph_stats', arguments: {} }, 'stats')
    await new Promise(resolve => setImmediate(resolve))
    await server.dispose()
    await expect(pending).rejects.toThrow(/closed/)
  })

  it('closes the transport when the child outcome rejects', async () => {
    const child = new FakeMcpChild((message) => {
      if (message.id !== undefined && message.method === 'initialize') child.reply(message.id, { capabilities: {} })
    })
    const handle = child.handle()
    const crashing = { ...handle, done: Promise.reject(new Error('child crashed')) }
    const server = await AstriaMcpServer.start(() => crashing, serverSpec, '/ws')
    await expect(server.call({ name: 'graph_stats', arguments: {} }, 'stats')).rejects.toThrow(/exited unexpectedly|closed/)
    expect(server.dead).toBe(true)
  })

  it('rejects calls after disposal', async () => {
    const child = new FakeMcpChild((message) => {
      if (message.id === undefined) return
      child.reply(message.id, { capabilities: {} })
    })
    const server = await AstriaMcpServer.start(() => child.handle(), serverSpec, '/ws')
    await server.dispose()
    await expect(server.call({ name: 'graph_stats', arguments: {} }, 'stats')).rejects.toThrow(/closed/)
  })
})
