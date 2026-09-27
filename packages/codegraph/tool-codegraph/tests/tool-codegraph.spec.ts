import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { JobHooks, JobId, JobSpec } from '@deepseek-ai/dsh-jobs'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CodeGraph, { CodeGraphError, CodeGraphProviderId, type CodeGraphProvider, type CodeGraphQueryRequest, type CodeGraphRefreshRequest, type CodeGraphResult } from '@deepseek-ai/dsh-codegraph'
import * as ToolCodeGraph from '@deepseek-ai/dsh-tool-codegraph'
import { CODEGRAPH_PROMPT_TEXT, CODEGRAPH_TOOL_OPERATIONS, DEFAULT_CODEGRAPH_TOOL_TIMEOUT_MS } from '@deepseek-ai/dsh-tool-codegraph'

/** A scripted provider recording queries and refreshes; `respond` yields the result or throws. */
function stubProvider(
  respond: (request: CodeGraphQueryRequest) => CodeGraphResult,
  refreshRespond: (request: CodeGraphRefreshRequest, signal?: AbortSignal) => CodeGraphResult = () => ({ kind: 'text', text: 'graph built', truncated: false }),
): CodeGraphProvider & { seen: CodeGraphQueryRequest[]; refreshes: CodeGraphRefreshRequest[] } {
  const seen: CodeGraphQueryRequest[] = []
  const refreshes: CodeGraphRefreshRequest[] = []
  return {
    id: CodeGraphProviderId('stub'),
    seen,
    refreshes,
    query(request) {
      seen.push(request)
      return Promise.resolve(respond(request))
    },
    refresh(request, signal) {
      refreshes.push(request)
      return Promise.resolve(refreshRespond(request, signal))
    },
  }
}

/** Mount the real tool stack over a real seam plus one stub provider. */
async function mount(provider?: CodeGraphProvider, config: ToolCodeGraph.Config = {}): Promise<{ ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CodeGraph)
  if (provider) (ctx.codeGraph as CodeGraph).registerProvider(provider)
  await ctx.plugin(ToolCodeGraph, config)
  return { ctx }
}

let seq = 0
const testToolSignal = new AbortController().signal
const workspaceRoot = resolve('/virtual/workspace')
/** `cwd: null` means "no agent" (tests CODEGRAPH_WORKSPACE_REQUIRED); a string is the session cwd. */
function call(ctx: Context, args: unknown, cwd: string | null = workspaceRoot) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: `c-${++seq}` as never,
    name: 'code_graph',
    arguments: args,
    ...cwd !== null ? { agent: { id: 'session-1', session: { header: { cwd } } } as never } : {},
  })
}

const okResult: CodeGraphResult = { kind: 'text', text: '# Repo map\n- packages/core', truncated: false }

describe('tool-codegraph registration', () => {
  it('registers the code_graph tool and its prompt section', async () => {
    const { ctx } = await mount(stubProvider(() => okResult))
    expect(ctx.tools.get('code_graph')).toBeDefined()
    const prompt = await ctx.systemPrompt.assemble()
    const text = prompt.sections.map(s => s.text).join('\n')
    expect(text).toContain(CODEGRAPH_PROMPT_TEXT)
  })

  it('attaches the default timeout budget to the tool definition', async () => {
    const { ctx } = await mount(stubProvider(() => okResult))
    expect(ctx.tools.get('code_graph')?.timeoutMs).toBe(DEFAULT_CODEGRAPH_TOOL_TIMEOUT_MS)
  })

  it('honors a configured timeout override', async () => {
    const { ctx } = await mount(stubProvider(() => okResult), { timeoutMs: 5000 })
    expect(ctx.tools.get('code_graph')?.timeoutMs).toBe(5000)
  })

  it('exposes exactly the twelve operations in the schema enum', async () => {
    const { ctx } = await mount(stubProvider(() => okResult))
    const schema = ctx.tools.get('code_graph')?.parameters as { properties: { operation: { enum: string[] } } }
    expect(schema.properties.operation.enum).toEqual([...CODEGRAPH_TOOL_OPERATIONS])
  })

  it('has no default export (namespace plugin shape)', () => {
    expect((ToolCodeGraph as { default?: unknown }).default).toBeUndefined()
  })

  it('rejects a non-positive config value at load', async () => {
    await expect(mount(stubProvider(() => okResult), { maxResultChars: 0 })).rejects.toThrow(/maxResultChars/)
  })

  it('rejects a fractional timeout at load', async () => {
    await expect(mount(stubProvider(() => okResult), { timeoutMs: 0.5 }))
      .rejects.toThrow(/timeoutMs/)
  })
})

/** A registry service that records and starts specs, issuing fixed ids. */
class FakeJobs extends JobRegistry {
  readonly specs: JobSpec[] = []
  readonly hooks: JobHooks[] = []
  readonly events = { subscribe: () => () => undefined }
  start(spec: JobSpec): JobId {
    this.specs.push(spec)
    this.hooks.push(spec.run({ id: 'codegraph-1' as JobId, append: () => undefined, updateProgress: () => undefined }))
    return 'codegraph-1' as JobId
  }
  list() { return [] }
  get(_id: never, _caller?: never): never { throw new Error('unused') }
  read(_id: never, _caller?: never): never { throw new Error('unused') }
  readAt(_id: never, _from: never, _caller?: never): never { throw new Error('unused') }
  kill(_id: never, _caller?: never, _reason?: string) { return 'already-finished' as const }
  async wait(_id: never, _timeoutMs: number, _caller?: never, _signal?: AbortSignal): Promise<never> { throw new Error('unused') }
  remove(_id: never, _caller?: never): void { throw new Error('unused') }
  attachController(_name: string) { return () => undefined }
}

/** Mount with a jobs registry so refresh operations can go background. */
async function mountWithJobs(provider?: CodeGraphProvider): Promise<{ ctx: Context; jobs: FakeJobs }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CodeGraph)
  if (provider) (ctx.codeGraph as CodeGraph).registerProvider(provider)
  await ctx.plugin(FakeJobs)
  await ctx.plugin(ToolCodeGraph, {})
  return { ctx, jobs: ctx.jobs as FakeJobs }
}

describe('tool-codegraph execution', () => {
  it('passes the session cwd and the derived token budget for repoMap', async () => {
    const provider = stubProvider(() => okResult)
    const { ctx } = await mount(provider)
    const result = await call(ctx, { operation: 'repoMap' })
    expect(result.isError).toBe(false)
    expect(provider.seen[0]).toEqual({
      root: workspaceRoot,
      query: { operation: 'repoMap', budgetTokens: 4000 },
    })
  })

  it('forwards query subjects and refinements', async () => {
    const provider = stubProvider(() => okResult)
    const { ctx } = await mount(provider)
    await call(ctx, { operation: 'query', question: 'how does auth work', depth: 3, directed: true })
    expect(provider.seen[0]).toMatchObject({
      root: workspaceRoot,
      query: { operation: 'query', question: 'how does auth work', depth: 3, directed: true, budgetTokens: 4000 },
    })
  })

  it('forwards path endpoints and affected nodes with depth', async () => {
    const provider = stubProvider(() => okResult)
    const { ctx } = await mount(provider)
    await call(ctx, { operation: 'path', source: 'boot', target: 'agent', directed: false })
    await call(ctx, { operation: 'affected', node: 'finalExtension', depth: 2 })
    expect(provider.seen[0]).toMatchObject({ query: { operation: 'path', source: 'boot', target: 'agent', directed: false } })
    expect(provider.seen[1]).toMatchObject({ query: { operation: 'affected', node: 'finalExtension', depth: 2 } })
  })

  it('passes a continuation cursor through to the seam query', async () => {
    const provider = stubProvider(() => okResult)
    const { ctx } = await mount(provider)
    await call(ctx, { operation: 'query', question: 'wide', cursor: 7 })
    expect(provider.seen[0]).toMatchObject({ query: { cursor: 7 } })
  })

  it('rejects a negative or fractional cursor', async () => {
    const { ctx } = await mount(stubProvider(() => okResult))
    expect((await call(ctx, { operation: 'query', question: 'q', cursor: -1 })).isError).toBe(true)
    expect((await call(ctx, { operation: 'query', question: 'q', cursor: 1.5 })).isError).toBe(true)
  })

  it('auto-starts a background build when the graph is missing', async () => {
    const missing = () => {
      throw new (CodeGraphError.bind(CodeGraphError))('No graph found at .astria/db.sqlite', 'CODEGRAPH_NO_GRAPH')
    }
    const provider = stubProvider(missing)
    const { ctx, jobs } = await mountWithJobs(provider)
    const result = await call(ctx, { operation: 'stats' })
    expect(result.isError).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('started background job codegraph-1')
    expect(jobs.specs[0]).toMatchObject({ kind: 'codegraph', label: `astria build ${workspaceRoot}` })
  })

  it('surfaces the missing-graph error when no job registry is composed', async () => {
    const missing = () => {
      throw new CodeGraphError('No graph found at .astria/db.sqlite', 'CODEGRAPH_NO_GRAPH')
    }
    const { ctx } = await mount(stubProvider(missing))
    const result = await call(ctx, { operation: 'stats' })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('No graph found')
  })

  it('surfaces the missing-graph error when refresh is disabled', async () => {
    const missing = () => {
      throw new (CodeGraphError.bind(CodeGraphError))('No graph found at .astria/db.sqlite', 'CODEGRAPH_NO_GRAPH')
    }
    const provider = stubProvider(missing)
    const { ctx } = await mount(provider, { allowRefresh: false })
    const result = await call(ctx, { operation: 'stats' })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('No graph found')
  })

  it('omits unset refinements from path and affected queries', async () => {
    const provider = stubProvider(() => okResult)
    const { ctx } = await mount(provider)
    await call(ctx, { operation: 'path', source: 'boot', target: 'agent' })
    await call(ctx, { operation: 'affected', node: 'finalExtension' })
    await call(ctx, { operation: 'explain', node: 'ToolRuntime' })
    expect(provider.seen[0]?.query).not.toHaveProperty('directed')
    expect(provider.seen[1]?.query).not.toHaveProperty('depth')
    expect(provider.seen[2]).toMatchObject({ query: { operation: 'explain', node: 'ToolRuntime' } })
  })

  it('exports a viewable artifact with the deterministic placement and reports its path', async () => {
    const provider = stubProvider(() => ({ kind: 'text', text: 'Exported HTML to: .astria/graph-view.html', truncated: false }))
    const { ctx } = await mount(provider)
    const result = await call(ctx, { operation: 'export' })
    expect(provider.seen[0]).toEqual({
      root: workspaceRoot,
      query: { operation: 'export', format: 'html', out: resolve(workspaceRoot, '.astria', 'graph-view.html') },
    })
    expect(result).toMatchObject({
      isError: false,
      value: { kind: 'export', format: 'html', path: '.astria/graph-view.html', truncated: false },
    })
    expect((result.content[0] as { text: string }).text).toContain('graph view artifact: .astria/graph-view.html')
  })

  it('forwards a requested svg format through the seam query', async () => {
    const provider = stubProvider(() => ({ kind: 'text', text: 'Exported SVG to: .astria/graph-view.svg', truncated: false }))
    const { ctx } = await mount(provider)
    const result = await call(ctx, { operation: 'export', format: 'svg' })
    expect(provider.seen[0]).toMatchObject({ query: { operation: 'export', format: 'svg' } })
    expect(result).toMatchObject({ value: { kind: 'export', format: 'svg', path: '.astria/graph-view.svg' } })
  })

  it('auto-starts a background build when an export finds no graph', async () => {
    const provider = stubProvider(() => { throw new CodeGraphError('No graph found', 'CODEGRAPH_NO_GRAPH') })
    const { ctx } = await mountWithJobs(provider)
    const result = await call(ctx, { operation: 'export' })
    expect(result).toMatchObject({ isError: false })
    expect((result.content[0] as { text: string }).text).toContain('started background job')
  })

  it('returns the canonical text value and renders the report', async () => {
    const { ctx } = await mount(stubProvider(() => okResult))
    const result = await call(ctx, { operation: 'stats' })
    expect(result.content[0]).toEqual({ type: 'text', text: '# Repo map\n- packages/core' })
    expect(result).toMatchObject({ isError: false, value: okResult })
  })

  it('derives the budget from a configured cap', async () => {
    const provider = stubProvider(() => okResult)
    const { ctx } = await mount(provider, { maxResultChars: 48 })
    await call(ctx, { operation: 'repoMap' })
    expect(provider.seen[0]).toMatchObject({ query: { budgetTokens: 12 } })
  })

  it('caps the rendered report within the configured characters', async () => {
    const { ctx } = await mount(stubProvider(() => ({ kind: 'text', text: 'x'.repeat(200), truncated: false })), { maxResultChars: 60 })
    const result = await call(ctx, { operation: 'repoMap' })
    const text = (result.content[0] as { text: string }).text
    expect(text.length).toBe(60)
    expect(text).toContain('report truncated (limit 60 characters)')
  })

  it('marks provider-side truncation in the rendered report', async () => {
    const { ctx } = await mount(stubProvider(() => ({ kind: 'text', text: 'partial tail', truncated: true })))
    const result = await call(ctx, { operation: 'query', question: 'anything' })
    expect((result.content[0] as { text: string }).text).toContain('output truncated by the provider')
  })

  it('requires a session workspace cwd (CODEGRAPH_WORKSPACE_REQUIRED)', async () => {
    const { ctx } = await mount(stubProvider(() => okResult))
    const result = await call(ctx, { operation: 'stats' }, null)
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('requires a session workspace cwd')
  })

  it('fails the call when no provider is registered', async () => {
    const { ctx } = await mount()
    const result = await call(ctx, { operation: 'stats' })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('no code-graph provider is registered')
  })

  it('rejects an unknown operation', async () => {
    const { ctx } = await mount(stubProvider(() => okResult))
    const result = await call(ctx, { operation: 'neighbors' })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('must be one of')
  })

  it('rejects a query without a question', async () => {
    const { ctx } = await mount(stubProvider(() => okResult))
    const result = await call(ctx, { operation: 'query' })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('question must be a non-empty string')
  })

  it('rejects explain without a node and path without endpoints', async () => {
    const { ctx } = await mount(stubProvider(() => okResult))
    expect((await call(ctx, { operation: 'explain' })).isError).toBe(true)
    expect((await call(ctx, { operation: 'path', source: 'a' })).isError).toBe(true)
  })

  it('rejects a non-positive depth', async () => {
    const { ctx } = await mount(stubProvider(() => okResult))
    const result = await call(ctx, { operation: 'affected', node: 'x', depth: 0 })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('depth must be a positive integer')
  })

  it('runs a foreground build through the seam refresh', async () => {
    const provider = stubProvider(() => okResult)
    const { ctx } = await mount(provider)
    const result = await call(ctx, { operation: 'build' })
    expect(result.isError).toBe(false)
    expect(provider.refreshes).toEqual([{ root: workspaceRoot, mode: 'build' }])
    expect(result).toMatchObject({ value: { kind: 'text', text: 'graph built' } })
  })

  it('runs a foreground update when no job registry is composed', async () => {
    const provider = stubProvider(() => okResult)
    const { ctx } = await mount(provider)
    const result = await call(ctx, { operation: 'update' })
    expect(result.isError).toBe(false)
    expect(provider.refreshes).toEqual([{ root: workspaceRoot, mode: 'update' }])
  })

  it('starts a background build job and returns its id', async () => {
    const provider = stubProvider(() => okResult)
    const { ctx, jobs } = await mountWithJobs(provider)
    const result = await call(ctx, { operation: 'build' })
    expect(result.isError).toBe(false)
    expect(result).toMatchObject({ value: { kind: 'background', jobId: 'codegraph-1' } })
    expect((result.content[0] as { text: string }).text).toBe('started background job codegraph-1')
    expect(jobs.specs[0]).toMatchObject({ kind: 'codegraph', label: `astria build ${workspaceRoot}`, owner: 'session-1' })
    expect(provider.refreshes).toEqual([{ root: workspaceRoot, mode: 'build' }])
    await expect(jobs.hooks[0]!.done).resolves.toEqual({ status: 'completed', detail: 'graph built' })
  })

  it('reports the update mode in a background job outcome', async () => {
    const provider = stubProvider(() => okResult)
    const { ctx, jobs } = await mountWithJobs(provider)
    await call(ctx, { operation: 'update' })
    expect(jobs.specs[0]).toMatchObject({ kind: 'codegraph', label: `astria update ${workspaceRoot}` })
    await expect(jobs.hooks[0]!.done).resolves.toEqual({ status: 'completed', detail: 'graph updated' })
  })

  it('maps a cancelled background refresh to a killed job outcome', async () => {
    const provider = stubProvider(
      () => okResult,
      (_request, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
      }) as unknown as CodeGraphResult,
    )
    const { ctx, jobs } = await mountWithJobs(provider)
    const { executed } = (() => {
      const agent = { id: 'session-1', session: { header: { cwd: workspaceRoot } } }
      return { executed: ctx.tools.execute({
        signal: new AbortController().signal,
        callId: 'c-cancel' as never,
        name: 'code_graph',
        arguments: { operation: 'update' },
        agent: agent as never,
      }) }
    })()
    await expect(executed).resolves.toBeDefined()
    jobs.hooks[0]!.cancel('stop')
    await expect(jobs.hooks[0]!.done).resolves.toEqual({ status: 'killed', detail: 'cancelled' })
  })

  it('maps a failed background refresh to a failed job outcome', async () => {
    const provider = stubProvider(() => okResult, () => {
      throw new Error('no graph found')
    })
    const { ctx, jobs } = await mountWithJobs(provider)
    await call(ctx, { operation: 'update' })
    await expect(jobs.hooks[0]!.done).resolves.toMatchObject({ status: 'failed', detail: 'no graph found' })
  })

  it('stringifies a non-Error background refresh failure', async () => {
    const provider = stubProvider(() => okResult, () => { throw 'disk full' })
    const { ctx, jobs } = await mountWithJobs(provider)
    await call(ctx, { operation: 'build' })
    await expect(jobs.hooks[0]!.done).resolves.toMatchObject({ status: 'failed', detail: 'disk full' })
  })

  it('treats a reason-less job cancellation as a plain kill', async () => {
    const provider = stubProvider(
      () => okResult,
      (_request, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
      }) as unknown as CodeGraphResult,
    )
    const { ctx, jobs } = await mountWithJobs(provider)
    await call(ctx, { operation: 'build' })
    jobs.hooks[0]!.cancel()
    await expect(jobs.hooks[0]!.done).resolves.toEqual({ status: 'killed', detail: 'cancelled' })
  })

  it('rejects refresh operations when disabled by configuration', async () => {
    const provider = stubProvider(() => okResult)
    const { ctx } = await mount(provider, { allowRefresh: false })
    const result = await call(ctx, { operation: 'build' })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('disabled for this deployment')
  })

  it('surfaces a provider failure as an error result the model can read', async () => {
    const boom = (): never => {
      throw new Error('astria stats failed with exit code 2: no graph found')
    }
    const { ctx } = await mount(stubProvider(boom))
    const result = await call(ctx, { operation: 'stats' })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('no graph found')
  })
})
