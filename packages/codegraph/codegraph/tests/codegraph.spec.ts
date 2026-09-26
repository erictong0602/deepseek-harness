import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CodeGraph, {
  CodeGraphError,
  CodeGraphProviderId,
  type CodeGraphProvider,
  type CodeGraphQueryRequest,
  type CodeGraphResult,
} from '@deepseek-ai/dsh-codegraph'

/** A scripted provider that records the queries it receives. */
function makeProvider(
  id = 'graph',
  result: CodeGraphResult = { kind: 'text', text: 'report', truncated: false },
): CodeGraphProvider & { seen: CodeGraphQueryRequest[]; seenSignals: (AbortSignal | undefined)[] } {
  const seen: CodeGraphQueryRequest[] = []
  const seenSignals: (AbortSignal | undefined)[] = []
  return {
    id: CodeGraphProviderId(id),
    seen,
    seenSignals,
    query(request, signal) {
      seen.push(request)
      seenSignals.push(signal)
      return Promise.resolve(result)
    },
  }
}

/** Mount a CodeGraph service on a fresh root context. */
async function mountCodeGraph(): Promise<{ ctx: Context; codeGraph: CodeGraph }> {
  const ctx = new Context()
  await ctx.plugin(CodeGraph)
  return { ctx, codeGraph: ctx.codeGraph as CodeGraph }
}

const request: CodeGraphQueryRequest = { root: '/ws', query: { operation: 'stats' } }

describe('CodeGraph registration', () => {
  it('registers a provider and routes a query to it, then releases the slot on dispose', async () => {
    const { codeGraph } = await mountCodeGraph()
    const provider = makeProvider()
    const dispose = codeGraph.registerProvider(provider)

    await expect(codeGraph.query(request)).resolves.toEqual({ kind: 'text', text: 'report', truncated: false })
    expect(provider.seen[0]).toEqual(request)

    dispose()
    await expect(codeGraph.query(request)).rejects.toThrow(expect.objectContaining({ code: 'CODEGRAPH_UNAVAILABLE' }))
  })

  it('accepts a successor after the previous registration disposes', async () => {
    const { codeGraph } = await mountCodeGraph()
    const dispose = codeGraph.registerProvider(makeProvider())
    dispose()
    expect(() => codeGraph.registerProvider(makeProvider('next'))).not.toThrow()
  })

  it('rejects an empty provider id (CODEGRAPH_INVALID_PROVIDER)', async () => {
    const { codeGraph } = await mountCodeGraph()
    expect(() => codeGraph.registerProvider(makeProvider('  ')))
      .toThrow(expect.objectContaining({ code: 'CODEGRAPH_INVALID_PROVIDER' }))
  })

  it('rejects a second provider in the same scope (CODEGRAPH_CONFLICT)', async () => {
    const { codeGraph } = await mountCodeGraph()
    codeGraph.registerProvider(makeProvider('first'))
    expect(() => codeGraph.registerProvider(makeProvider('second')))
      .toThrow(expect.objectContaining({ code: 'CODEGRAPH_CONFLICT' }))
    // The failed registration published nothing; the first provider still answers.
    await expect(codeGraph.query(request)).resolves.toMatchObject({ text: 'report' })
  })

  it('throws CODEGRAPH_UNAVAILABLE when no provider is registered', async () => {
    const { codeGraph } = await mountCodeGraph()
    await expect(codeGraph.query(request)).rejects.toThrow(expect.objectContaining({ code: 'CODEGRAPH_UNAVAILABLE' }))
  })

  it('forwards the cancellation signal to the selected provider', async () => {
    const { codeGraph } = await mountCodeGraph()
    const provider = makeProvider()
    codeGraph.registerProvider(provider)
    const signal = new AbortController().signal
    await codeGraph.query(request, signal)
    expect(provider.seenSignals[0]).toBe(signal)
  })
})

describe('CodeGraphError', () => {
  it('carries a stable code callers route on', () => {
    const error = new CodeGraphError('boom', 'CODEGRAPH_UNAVAILABLE')
    expect(error.code).toBe('CODEGRAPH_UNAVAILABLE')
    expect(error.message).toBe('boom')
  })
})
