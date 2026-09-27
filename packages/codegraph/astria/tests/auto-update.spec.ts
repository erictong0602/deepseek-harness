import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CodeGraph from '@deepseek-ai/dsh-codegraph'
import { JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { JobId, JobSpec } from '@deepseek-ai/dsh-jobs'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import * as Astria from '@deepseek-ai/dsh-astria'

/** A registry service that records specs and starts them; `admissionError` refuses instead. */
class FakeJobs extends JobRegistry {
  readonly specs: JobSpec[] = []
  private readonly admissionError: Error | undefined

  constructor(ctx: Context, config: { admissionError?: Error | undefined } = {}) {
    super(ctx)
    this.admissionError = config.admissionError
  }

  start(spec: JobSpec): JobId {
    if (this.admissionError !== undefined) throw this.admissionError
    this.specs.push(spec)
    spec.run({ id: 'codegraph-1' as JobId, append: () => undefined, updateProgress: () => undefined })
    return 'codegraph-1' as JobId
  }

  readonly events = { subscribe: () => () => undefined }
  list() { return [] }
  get(_id: never, _caller?: never): never { throw new Error('unused') }
  read(_id: never, _caller?: never): never { throw new Error('unused') }
  readAt(_id: never, _from: never, _caller?: never): never { throw new Error('unused') }
  kill(_id: never, _caller?: never, _reason?: string) { return 'already-finished' as const }
  async wait(_id: never, _timeoutMs: number, _caller?: never, _signal?: AbortSignal): Promise<never> { throw new Error('unused') }
  remove(_id: never, _caller?: never): void { throw new Error('unused') }
  attachController(_name: string) { return () => undefined }
}

/** A subprocess service resolving any command, recording spawns, and answering exit 0. */
class RecordingSubprocess extends SubprocessRuntime {
  readonly spawned: SubprocessSpawnSpec[] = []

  resolveExecutable(command: string): Promise<string> {
    return Promise.resolve(`/resolved/${command}`)
  }

  async terminalEnvironment() {
    return { platform: 'posix' as const }
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.spawned.push(spec)
    return {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected: {
        stdout: { readFrom: () => ({ text: 'updated', nextOffset: 7, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: () => undefined,
      waitForExit: () => Promise.resolve(true),
    }
  }

  spawnTerminal(): never {
    throw new Error('terminal spawns are outside these tests')
  }
}

/** The agent double the tool pipeline carries; records injected notices. */
interface FakeAgent {
  id: string
  session: { header: { cwd: string | undefined } }
  notices: unknown[]
  inject(notice: unknown): void
}

function fakeAgent(cwd: string | undefined): FakeAgent {
  const notices: unknown[] = []
  return {
    id: 'session-1',
    session: { header: { cwd } },
    notices,
    inject(notice: unknown): void {
      notices.push(notice)
    },
  }
}

/** Mount the seam, the real provider over a recording subprocess host, jobs, and a write tool. */
async function mount(config: Astria.Config, admissionError?: Error): Promise<{
  ctx: Context
  subprocess: RecordingSubprocess
  jobs: FakeJobs
}> {
  const ctx = new Context()
  await ctx.plugin(CodeGraph)
  await ctx.plugin(RecordingSubprocess)
  await ctx.plugin(FakeJobs, { admissionError })
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
  const subprocess = ctx.subprocess as RecordingSubprocess
  const jobs = ctx.jobs as FakeJobs
  return { ctx, subprocess, jobs }
}

let seq = 0

/** One call of the write tool; returns the agent double it carried, when one did. */
function write(ctx: Context, cwd: string | undefined): { executed: Promise<unknown>; agent: FakeAgent | undefined } {
  const agent = cwd === undefined ? undefined : fakeAgent(cwd)
  const executed = ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `w-${++seq}` as never,
    name: 'write',
    arguments: { path: 'a.ts' },
    ...agent !== undefined ? { agent: agent as never } : {},
  })
  return { executed, agent }
}

/** The recorded refresh spawns: argv running `astria update --graph`. */
function refreshSpawns(spawned: readonly SubprocessSpawnSpec[]): SubprocessSpawnSpec[] {
  return spawned.filter(spec => spec.argv[0] === '/resolved/astria' && spec.argv[1] === 'update')
}

/** Poll until the condition holds; the debounce runs on wall time. */
async function until(read: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (read()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition not reached before timeout')
}

describe('autoUpdate listener', () => {
  it('refreshes the graph once after a watched edit, then notifies the owning agent', async () => {
    const { ctx, subprocess, jobs } = await mount({ autoUpdate: { enabled: true, debounceMs: 15 } })
    const { executed, agent } = write(ctx, '/ws')
    await expect(executed).resolves.toBeDefined()
    await until(() => jobs.specs.length > 0)
    const refreshes = refreshSpawns(subprocess.spawned)
    expect(refreshes[0]?.argv).toEqual(['/resolved/astria', 'update', '--graph', '/ws'])
    expect(jobs.specs[0]).toMatchObject({ kind: 'codegraph', label: 'astria update /ws', owner: 'session-1' })
    await until(() => agent !== undefined && agent.notices.length > 0)
    expect(String((agent!.notices[0] as { content: readonly { text?: string }[] }).content[0]?.text)).toContain('astria updated the code graph')
  })

  it('collapses rapid edits into one refresh', async () => {
    const { ctx, subprocess, jobs } = await mount({ autoUpdate: { enabled: true, debounceMs: 40 } })
    write(ctx, '/ws')
    write(ctx, '/ws')
    await until(() => jobs.specs.length > 0)
    expect(refreshSpawns(subprocess.spawned)).toHaveLength(1)
  })

  it('ignores unwatched tools, agent-less calls, and agents without a cwd', async () => {
    const { ctx, subprocess, jobs } = await mount({ autoUpdate: { enabled: true, debounceMs: 15, tools: ['edit'] } })
    write(ctx, '/ws')
    write(ctx, undefined)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(jobs.specs).toHaveLength(0)
    expect(refreshSpawns(subprocess.spawned)).toHaveLength(0)
  })

  it('does not register the listener when disabled (the default)', async () => {
    const { ctx, jobs } = await mount({})
    write(ctx, '/ws')
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(jobs.specs).toHaveLength(0)
  })

  it('clears pending debounces when the plugin scope disposes', async () => {
    const { ctx, jobs } = await mount({ autoUpdate: { enabled: true, debounceMs: 200 } })
    const { executed } = write(ctx, '/ws')
    await expect(executed).resolves.toBeDefined()
    await ctx.fiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 320))
    expect(jobs.specs).toHaveLength(0)
  })

  it('contains a refused job admission inside a warning', async () => {
    const { ctx, subprocess } = await mount({ autoUpdate: { enabled: true, debounceMs: 15 } }, new Error('job limit reached'))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    write(ctx, '/ws')
    await until(() => warn.mock.calls.length > 0)
    expect(refreshSpawns(subprocess.spawned)).toHaveLength(0)
    warn.mockRestore()
  })
})
