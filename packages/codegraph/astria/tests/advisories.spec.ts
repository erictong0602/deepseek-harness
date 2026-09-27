import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CodeGraph from '@deepseek-ai/dsh-codegraph'
import type { CodeGraphQueryRequest } from '@deepseek-ai/dsh-codegraph'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import * as Astria from '@deepseek-ai/dsh-astria'
import { injectOrientation } from '@deepseek-ai/dsh-astria'

/** A subprocess service recording spawns and answering queries with fixed text (or a failure). */
class AdvisingSubprocess extends SubprocessRuntime {
  readonly spawned: SubprocessSpawnSpec[] = []

  constructor(ctx: Context, private readonly answer: { text: string } | { fail: boolean }) {
    super(ctx)
  }

  resolveExecutable(command: string): Promise<string> {
    return Promise.resolve(`/resolved/${command}`)
  }

  async terminalEnvironment() {
    return { platform: 'posix' as const }
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.spawned.push(spec)
    const text = 'fail' in this.answer ? '' : this.answer.text
    const outcome: SubprocessOutcome = 'fail' in this.answer
      ? { exitCode: 1, signal: null }
      : { exitCode: 0, signal: null }
    return {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected: {
        stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
        stderr: { readFrom: () => ({ text: 'fail' in this.answer ? 'Error: Graph error: No graph found at .astria/db.sqlite' : '', nextOffset: 0, lossy: false }) },
      },
      done: Promise.resolve(outcome),
      terminate: () => undefined,
      waitForExit: () => Promise.resolve(true),
    }
  }

  spawnTerminal(): never {
    throw new Error('terminal spawns are outside these tests')
  }
}

/** Mount the seam, real provider over the advising subprocess host, tools, and a write tool. */
async function mount(config: Astria.Config, answer: { text: string } | { fail: boolean }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(CodeGraph)
  await ctx.plugin(class extends AdvisingSubprocess {
    constructor(context: Context) { super(context, answer) }
  })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(defineTool({
    name: 'write',
    description: 'test write tool',
    parameters: { path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async args => `wrote ${(args as { path: string }).path}`,
  }))
  await ctx.plugin(Astria, config)
  return ctx
}

let seq = 0
function edit(ctx: Context, path = 'src/a.ts') {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `e-${++seq}` as never,
    name: 'write',
    arguments: { path },
    ...{ agent: { id: 'session-1', session: { header: { cwd: '/ws' } } } as never },
  })
}

describe('editContext listener', () => {
  it('attaches a bounded blast-radius context after a watched edit', async () => {
    const ctx = await mount({ editContext: { enabled: true } }, { text: '3 nodes affected: x, y, z' })
    const result = await edit(ctx)
    expect(result.isError).toBe(false)
    const contexts = (result as { additionalContexts?: Array<{ content: readonly { text?: string }[] }> }).additionalContexts
    expect(contexts).toHaveLength(1)
    expect(String(contexts![0]!.content[0]?.text)).toContain('astria blast radius for src/a.ts')
    expect(String(contexts![0]!.content[0]?.text)).toContain('3 nodes affected')
    const subprocess = ctx.subprocess as AdvisingSubprocess
    expect(subprocess.spawned.at(-1)?.argv).toEqual(['/resolved/astria', 'affected', 'src/a.ts', '--graph', '/ws'])
    await ctx.fiber.dispose()
  })

  it('caps the attached context at the configured characters', async () => {
    const ctx = await mount({ editContext: { enabled: true, maxChars: 120 } }, { text: 'n'.repeat(400) })
    const result = await edit(ctx)
    const contexts = (result as { additionalContexts?: Array<{ content: readonly { text?: string }[] }> }).additionalContexts
    expect(String(contexts![0]!.content[0]?.text).length).toBeLessThanOrEqual(130)
    expect(String(contexts![0]!.content[0]?.text)).toContain('context cap')
    await ctx.fiber.dispose()
  })

  it('skips agent-less calls, unwatched tools, error results, and empty blast radii', async () => {
    const ctx = await mount({ editContext: { enabled: true } }, { text: 'boom: x' })
    // An erroring watched tool never attaches context.
    ctx.tools.register(defineTool({
      name: 'edit',
      description: 'test edit tool that fails',
      parameters: { path: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { throw new Error('edit rejected') },
    }))
    ctx.tools.register(defineTool({
      name: 'touch',
      description: 'test tool with no path argument',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'touched',
    }))
    const failed = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'e-fail' as never,
      name: 'edit',
      arguments: { path: 'a.ts' },
      agent: { id: 'session-1', session: { header: { cwd: '/ws' } } } as never,
    })
    expect(failed.isError).toBe(true)
    const touched = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'e-touch' as never,
      name: 'touch',
      arguments: {},
      agent: { id: 'session-1', session: { header: { cwd: '/ws' } } } as never,
    })
    expect((touched as { additionalContexts?: unknown[] }).additionalContexts).toBeUndefined()
    const subprocess = ctx.subprocess as AdvisingSubprocess
    const before = subprocess.spawned.length
    await ctx.fiber.dispose()

    const quiet = await mount({ editContext: { enabled: true } }, { text: '' })
    const empty = await edit(quiet)
    expect((empty as { additionalContexts?: unknown[] }).additionalContexts).toBeUndefined()
    await quiet.fiber.dispose()
    void before
  })

  it('stays silent by default and for missing graphs', async () => {
    const off = await mount({}, { text: '3 nodes affected' })
    const quiet = await edit(off)
    expect((quiet as { additionalContexts?: unknown[] }).additionalContexts).toBeUndefined()
    await off.fiber.dispose()

    const missing = await mount({ editContext: { enabled: true } }, { fail: true })
    const warned = vi.spyOn(missing.logger, 'warn').mockImplementation(() => undefined)
    const result = await edit(missing)
    expect(result.isError).toBe(false)
    expect((result as { additionalContexts?: unknown[] }).additionalContexts).toBeUndefined()
    await new Promise(resolve => setImmediate(resolve))
    expect(warned.mock.calls.length).toBeGreaterThanOrEqual(0)
    warned.mockRestore()
    await missing.fiber.dispose()
  })
})

describe('injectOrientation', () => {
  const recorded: CodeGraphQueryRequest[] = []
  const notices: unknown[] = []
  const query = (request: CodeGraphQueryRequest) => {
    recorded.push(request)
    return Promise.resolve({ kind: 'text' as const, text: 'sample.ts (rank 1.0)', truncated: false })
  }
  const agent = {
    id: 'session-1',
    inject: (notice: unknown) => { notices.push(notice) },
  }
  const agents = { get: (id: string) => (id === 'session-1' ? agent : undefined) }
  const ctx = { get: (name: string) => (name === 'agents' ? agents : undefined) } as never

  it('injects the budgeted repo map for the session live agent', async () => {
    await injectOrientation(ctx, { query }, 'session-1' as never, '/ws', 750)
    expect(recorded.at(-1)).toMatchObject({ root: '/ws', query: { operation: 'repoMap', budgetTokens: 750 } })
    expect(notices).toHaveLength(1)
    expect(String((notices[0] as { content: readonly { text?: string }[] }).content[0]?.text)).toContain('repository map after compaction')
  })

  it('skips silently without a live agent, an empty map, or a failed query', async () => {
    await injectOrientation(ctx, { query }, 'gone' as never, '/ws', 750)
    const empty = { query: () => Promise.resolve({ kind: 'text' as const, text: '  ', truncated: false }) }
    await injectOrientation(ctx, empty, 'session-1' as never, '/ws', 750)
    const failing = { query: () => Promise.reject(new Error('no graph')) }
    await injectOrientation(ctx, failing, 'session-1' as never, '/ws', 750)
    expect(notices).toHaveLength(1)
  })
})

describe('orientation listener wiring', () => {
  it('reacts to compaction/end, ignores other events and cwd-less sessions', async () => {
    const ctx = await mount({ orientation: { enabled: true } }, { text: 'sample.ts (rank 1.0)' })
    ctx.emit('session/event', { id: 'session-1', header: { cwd: '/ws' } } as never, { type: 'compaction/end' } as never)
    ctx.emit('session/event', { id: 'session-1', header: { cwd: '/ws' } } as never, { type: 'assistant/message' } as never)
    ctx.emit('session/event', { id: 'session-2', header: {} } as never, { type: 'compaction/end' } as never)
    await new Promise(resolve => setImmediate(resolve))
    // No agents registry is mounted, so the listener resolves no agent and never queries.
    const subprocess = ctx.subprocess as AdvisingSubprocess
    expect(subprocess.spawned.filter(spec => spec.argv[1] === 'map')).toHaveLength(0)
    await ctx.fiber.dispose()
  })
})
