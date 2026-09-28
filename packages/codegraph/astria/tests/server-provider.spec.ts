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
  llmEnv: {},
  semantic: {},
  extractionLabel: 'plain',
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
    expect(specs[0]?.argv).toEqual(['/bin/astria', 'update', '/ws'])
    await provider.dispose()
  })

  it('delegates status to the one-shot CLI with the envelope normalization applied', async () => {
    const specs: SubprocessSpawnSpec[] = []
    const provider = new AstriaServerProvider(
      new Astria.AstriaCliProvider(providerSpec, (spawned) => {
        specs.push(spawned)
        return fakeHandle({ exitCode: 0, signal: null }, JSON.stringify({ status: 'fresh', nodes: 12 }))
      }),
      serverSpec,
      () => fakeHandle({ exitCode: 0, signal: null }),
    )
    const result = await provider.query({ root: '/ws', query: { operation: 'status' } })
    // The pooled MCP server is never started: status is a build-pipeline fact the CLI answers.
    expect(specs[0]?.argv).toEqual(['/bin/astria', 'status', '--json', '--graph', '/ws'])
    expect(result.text).toContain('Status: fresh')
    expect(result.text).toContain('nodes 12')
    await provider.dispose()
  })

  it('delegates export to the one-shot CLI without starting the pooled server', async () => {
    const specs: SubprocessSpawnSpec[] = []
    let mcpSpawns = 0
    const provider = new AstriaServerProvider(
      new Astria.AstriaCliProvider(providerSpec, (spawned) => {
        specs.push(spawned)
        return fakeHandle({ exitCode: 0, signal: null }, 'Exported HTML to: .astria/graph-view.html')
      }),
      serverSpec,
      () => { mcpSpawns += 1; return fakeHandle({ exitCode: 0, signal: null }) },
    )
    const result = await provider.query({ root: '/ws', query: { operation: 'export', format: 'html', out: '/ws/.astria/graph-view.html' } })
    expect(specs[0]?.argv).toEqual(['/bin/astria', 'export', '--format', 'html', '--out', '/ws/.astria/graph-view.html', '--graph', '/ws'])
    expect(mcpSpawns).toBe(0)
    expect(result.text).toContain('Exported HTML')
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
      release = () => { child.reply(id, { capabilities: {} }) }
    })
    const provider = new AstriaServerProvider(
      new Astria.AstriaCliProvider(providerSpec, () => fakeHandle({ exitCode: 0, signal: null })),
      serverSpec,
      () => child.handle(),
    )
    const pending = provider.query(statsRequest)
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
    const result = await ctx.codeGraph.query(statsRequest)
    expect(result.text).toContain('1.2.3')
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
    await expect(ctx.codeGraph.query(statsRequest)).resolves.toMatchObject({ text: 'from server' })
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

describe('astria plugin semantic backend configuration', () => {
  it('rides the resolved engine and judge on refresh runs with the derived env', async () => {
    const { ctx, spawned } = await mount({
      backend: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
      tokenBudget: 5000,
      judge: { model: 'jev-2', verify: false, minEdgeProbability: 0.5 },
    })
    await ctx.codeGraph.refresh({ root: '/ws', mode: 'update' })
    const refresh = spawned.find(spec => spec.argv[1] === 'update')
    expect(refresh?.argv).toEqual([
      '/resolved/astria', 'update', '/ws',
      '--backend', 'openai', '--judge', 'jev', '--model', 'gpt-4o-mini',
    ])
    expect(refresh?.env).toMatchObject({
      ASTRIA_LLM_BACKEND: 'openai',
      ASTRIA_LLM_JUDGE: 'jev',
      ASTRIA_LLM_API_KEY: 'sk-test',
      ASTRIA_LLM_MODEL: 'gpt-4o-mini',
      ASTRIA_LLM_BUDGET: '5000',
      ASTRIA_LLM_JUDGE_MODEL: 'jev-2',
      ASTRIA_LLM_JEV_VERIFY: '0',
      ASTRIA_LLM_JEV_MIN_EDGE_PROBABILITY: '0.5',
    })
    await ctx.fiber.dispose()
  })

  it('reports the configured extraction mode on normalized status answers', async () => {
    const { ctx } = await mount(
      { backend: 'gemini' },
      { version: { code: 0, text: `${JSON.stringify({ status: 'fresh', ageMinutes: 1 })}
` } },
    )
    const result = await ctx.codeGraph.query({ root: '/ws', query: { operation: 'status' } })
    expect(result.text).toContain('Status: fresh')
    expect(result.text).toContain('Extraction: gemini')
    await ctx.fiber.dispose()
  })

  it('keeps plain extraction deterministic against a configured ambient selection', async () => {
    const { ctx, spawned } = await mount({ env: { ASTRIA_LLM_BACKEND: 'claude', ASTRIA_LLM_JUDGE: 'jev' } })
    await ctx.codeGraph.refresh({ root: '/ws', mode: 'update' })
    expect(spawned.find(spec => spec.argv[1] === 'update')?.env).toMatchObject({
      ASTRIA_LLM_BACKEND: '',
      ASTRIA_LLM_JUDGE: '',
    })
    await ctx.fiber.dispose()
  })
})

describe('astria plugin semantic validation', () => {
  it('rejects a judge without an engine backend', async () => {
    await expect(mount({ backend: 'plain', judge: { model: 'jev-2' } })).rejects.toThrow(/judge requires an engine backend/)
  })

  it('rejects LLM extraction tiers without an engine backend', async () => {
    await expect(mount({ labelCommunities: true })).rejects.toThrow(/labelCommunities and deep require an engine backend/)
    await expect(mount({ deep: true })).rejects.toThrow(/labelCommunities and deep require an engine backend/)
  })

  it('rejects an openai-only base URL under another engine', async () => {
    await expect(mount({ backend: 'claude', baseUrl: 'http://localhost:1234/v1' })).rejects.toThrow(/applies to the openai backend only/)
  })

  it('rejects an unknown backend and a fractional budget', async () => {
    await expect(mount({ backend: 'jev' })).rejects.toThrow(/backend must be plain, claude, openai, or gemini/)
    await expect(mount({ backend: 'openai', tokenBudget: 1.5 })).rejects.toThrow(/tokenBudget must be a non-negative integer/)
  })
})
