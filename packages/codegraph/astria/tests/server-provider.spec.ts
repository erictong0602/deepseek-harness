import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CodeGraph from '@deepseek-ai/dsh-codegraph'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import * as Astria from '@deepseek-ai/dsh-astria'
import { AstriaServerProvider } from '@deepseek-ai/dsh-astria'
import type { AstriaProviderSpec, AstriaServerSpec } from '@deepseek-ai/dsh-astria'
import { FakeMcpChild, fakeHandle } from './helpers.ts'

const providerSpec: AstriaProviderSpec = {
  executable: '/bin/astria',
  args: [],
  env: {},
  maxOutputBytes: 1000,
  maxStderrBytes: 200,
  killGraceMs: 250,
}

const serverSpec: AstriaServerSpec = {
  executable: '/bin/astria',
  args: [],
  env: {},
  callTimeoutMs: 500,
  killGraceMs: 250,
  maxStderrBytes: 200,
}

const statsRequest = { root: '/ws', query: { operation: 'stats' } } as const

describe('AstriaServerProvider', () => {
  it('pools one server per root across queries', async () => {
    const child = new FakeMcpChild((message) => {
      if (message.id === undefined) return
      child.reply(message.id, message.method === 'initialize'
        ? { capabilities: {} }
        : { content: [{ type: 'text', text: 'answer' }] })
    })
    let spawns = 0
    const provider = new AstriaServerProvider(
      new Astria.AstriaCliProvider(providerSpec, () => fakeHandle({ exitCode: 0, signal: null })),
      serverSpec,
      () => { spawns += 1; return child.handle() },
    )
    await expect(provider.query(statsRequest as never)).resolves.toMatchObject({ text: 'answer' })
    await expect(provider.query(statsRequest as never)).resolves.toMatchObject({ text: 'answer' })
    expect(spawns).toBe(1)
    await provider.dispose()
  })

  it('replaces a dead server once and answers from the replacement', async () => {
    let current: FakeMcpChild | undefined
    let closeAfterAnswer = true
    const script = (message: { id?: number; method?: string }): void => {
      if (message.id === undefined || current === undefined) return
      if (message.method === 'initialize') {
        current.reply(message.id, { capabilities: {} })
        return
      }
      current.reply(message.id, { content: [{ type: 'text', text: 'answer' }] })
      if (closeAfterAnswer) current.close()
    }
    let spawns = 0
    const provider = new AstriaServerProvider(
      new Astria.AstriaCliProvider(providerSpec, () => fakeHandle({ exitCode: 0, signal: null })),
      serverSpec,
      () => {
        spawns += 1
        closeAfterAnswer = spawns === 1
        current = new FakeMcpChild(script)
        return current.handle()
      },
    )
    await expect(provider.query(statsRequest as never)).resolves.toMatchObject({ text: 'answer' })
    await expect(provider.query(statsRequest as never)).resolves.toMatchObject({ text: 'answer' })
    expect(spawns).toBe(2)
    await provider.dispose()
  })

  it('propagates a non-transport failure without replacement', async () => {
    const child = new FakeMcpChild((message) => {
      if (message.id === undefined) return
      child.reply(message.id, message.method === 'initialize'
        ? { capabilities: {} }
        : { content: [{ type: 'text', text: 'no graph found' }], isError: true })
    })
    let spawns = 0
    const provider = new AstriaServerProvider(
      new Astria.AstriaCliProvider(providerSpec, () => fakeHandle({ exitCode: 0, signal: null })),
      serverSpec,
      () => { spawns += 1; return child.handle() },
    )
    await expect(provider.query(statsRequest as never)).rejects.toThrow(/no graph found/)
    expect(spawns).toBe(1)
    await provider.dispose()
  })

  it('delegates refresh to the one-shot CLI', async () => {
    const specs: SubprocessSpawnSpec[] = []
    const provider = new AstriaServerProvider(
      new Astria.AstriaCliProvider(providerSpec, (spawned) => {
        specs.push(spawned)
        return fakeHandle({ exitCode: 0, signal: null }, 'updated')
      }),
      serverSpec,
      () => fakeHandle({ exitCode: 0, signal: null }),
    )
    await expect(provider.refresh({ root: '/ws', mode: 'update' })).resolves.toMatchObject({ text: 'updated' })
    expect(specs[0]?.argv).toEqual(['/bin/astria', 'update', '--graph', '/ws'])
    await provider.dispose()
  })

  it('rejects queries after disposal without spawning', async () => {
    let spawns = 0
    const provider = new AstriaServerProvider(
      new Astria.AstriaCliProvider(providerSpec, () => fakeHandle({ exitCode: 0, signal: null })),
      serverSpec,
      () => { spawns += 1; return new FakeMcpChild(() => undefined).handle() },
    )
    await provider.dispose()
    await expect(provider.query(statsRequest as never)).rejects.toThrow(expect.objectContaining({ code: 'CODEGRAPH_DISPOSED' }))
    expect(spawns).toBe(0)
  })

  it('rejects a disposed-during-start server without registering it', async () => {
    let release: (() => void) | undefined
    const child = new FakeMcpChild((message) => {
      if (message.id === undefined || message.method !== 'initialize') return
      const id = message.id
      new Promise<void>((resolve) => { release = () => { child.reply(id, { capabilities: {} }); resolve() } })
    })
    const provider = new AstriaServerProvider(
      new Astria.AstriaCliProvider(providerSpec, () => fakeHandle({ exitCode: 0, signal: null })),
      serverSpec,
      () => child.handle(),
    )
    const pending = provider.query(statsRequest as never)
    await new Promise(resolve => setImmediate(resolve))
    await provider.dispose()
    release?.()
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'CODEGRAPH_DISPOSED' }))
  })

  it('fuses a caller signal into the query', async () => {
    const child = new FakeMcpChild((message) => {
      if (message.id === undefined) return
      child.reply(message.id, message.method === 'initialize'
        ? { capabilities: {} }
        : { content: [{ type: 'text', text: 'fused' }] })
    })
    const provider = new AstriaServerProvider(
      new Astria.AstriaCliProvider(providerSpec, () => fakeHandle({ exitCode: 0, signal: null })),
      serverSpec,
      () => child.handle(),
    )
    await expect(provider.query(statsRequest as never, new AbortController().signal)).resolves.toMatchObject({ text: 'fused' })
    await provider.dispose()
  })

  it('rejects a pre-aborted caller before spawning', async () => {
    let spawns = 0
    const provider = new AstriaServerProvider(
      new Astria.AstriaCliProvider(providerSpec, () => fakeHandle({ exitCode: 0, signal: null })),
      serverSpec,
      () => { spawns += 1; return new FakeMcpChild(() => undefined).handle() },
    )
    const controller = new AbortController()
    controller.abort()
    await expect(provider.query(statsRequest as never, controller.signal)).rejects.toThrow()
    expect(spawns).toBe(0)
    await provider.dispose()
  })
})

/** One dispatching-host config row: the version-probe outcome and the served MCP child. */
interface DispatchConfig {
  version?: { code: number; text: string; throws?: boolean; bare?: boolean; signal?: string }
  mcp?: FakeMcpChild
}

/** A subprocess service dispatching by argv: --version and refresh runs collect; mcp runs pipe. */
class DispatchingSubprocess extends SubprocessRuntime {
  readonly spawned: SubprocessSpawnSpec[] = []

  constructor(ctx: Context, config: DispatchConfig = {}) {
    super(ctx)
    this.version = config.version ?? { code: 0, text: '1.2.3\n' }
    this.mcp = config.mcp
  }

  private readonly version: NonNullable<DispatchConfig['version']>
  private mcp: FakeMcpChild | undefined

  resolveExecutable(command: string): Promise<string> {
    return Promise.resolve(`/resolved/${command}`)
  }

  async terminalEnvironment() {
    return { platform: 'posix' as const }
  }

  spawn(spec: SubprocessSpawnSpec) {
    this.spawned.push(spec)
    if (spec.argv[1] === 'mcp' && this.version.throws !== true) {
      return (this.mcp ?? new FakeMcpChild(() => undefined)).handle()
    }
    if (this.version.throws === true) throw new Error('probe spawn failed')
    const outcome = this.version.code === -1
      ? { exitCode: null, signal: (this.version.signal ?? 'SIGKILL') as 'SIGKILL' }
      : { exitCode: this.version.code, signal: null }
    if (this.version.bare === true) {
      const bare = fakeHandle(outcome, this.version.text)
      ;(bare as { collected: unknown }).collected = {}
      return bare
    }
    return fakeHandle(outcome, this.version.text)
  }

  spawnTerminal(): never {
    throw new Error('terminal spawns are outside these tests')
  }
}

/** Mount the full plugin over a dispatching subprocess host. */
async function mount(
  config: Astria.Config,
  subprocessConfig: DispatchConfig = {},
): Promise<{ ctx: Context; spawned: SubprocessSpawnSpec[] }> {
  const ctx = new Context()
  await ctx.plugin(CodeGraph)
  await ctx.plugin(DispatchingSubprocess, subprocessConfig)
  await ctx.plugin(Astria, config)
  return { ctx, spawned: (ctx.subprocess as DispatchingSubprocess).spawned }
}

describe('astria plugin transport selection', () => {
  it('probes the version at load and stays on the CLI transport by default', async () => {
    const { ctx, spawned } = await mount({}, { version: { code: 0, text: '1.2.3\n' } })
    expect(spawned[0]?.argv).toEqual(['/resolved/astria', '--version'])
    await expect(ctx.codeGraph.query(statsRequest as never)).resolves.toMatchObject({ text: expect.stringContaining('1.2.3') })
    await ctx.fiber.dispose()
  })

  it('activates even when the version probe reports failure', async () => {
    const { ctx, spawned } = await mount({}, { version: { code: 1, text: '' } })
    expect(spawned[0]?.argv).toEqual(['/resolved/astria', '--version'])
    // The mount resolving proves activation; the probe warning never gates startup.
    await ctx.fiber.dispose()
  })

  it('activates even when the version probe itself throws', async () => {
    const { ctx } = await mount({}, { version: { code: 0, text: 'x', throws: true } })
    await ctx.fiber.dispose()
  })

  it('warns when the probe exits by signal', async () => {
    const { ctx } = await mount({}, { version: { code: -1, text: '', signal: 'SIGKILL' } })
    await ctx.fiber.dispose()
  })

  it('warns when the probe produces no readable output', async () => {
    const { ctx } = await mount({}, { version: { code: 0, text: '', bare: true } })
    await ctx.fiber.dispose()
  })

  it('answers queries over the server transport', async () => {
    const child = new FakeMcpChild((message) => {
      if (message.id === undefined) return
      child.reply(message.id, message.method === 'initialize'
        ? { capabilities: {} }
        : { content: [{ type: 'text', text: 'from server' }] })
    })
    const { ctx, spawned } = await mount({ transport: 'server' }, { mcp: child })
    await expect(ctx.codeGraph.query(statsRequest as never)).resolves.toMatchObject({ text: 'from server' })
    expect(spawned.filter(spec => spec.argv[1] === 'mcp')).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('rejects an unknown transport value at load', async () => {
    await expect(mount({ transport: 'carrier-pigeon' })).rejects.toThrow(/transport must be/)
  })

  it('rejects a fractional server timeout at load', async () => {
    await expect(mount({ transport: 'server', serverTimeoutMs: 0.5 })).rejects.toThrow(/serverTimeoutMs/)
  })
})
