import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CodeGraph from '@deepseek-ai/dsh-codegraph'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import * as Astria from '@deepseek-ai/dsh-astria'
import type { CodeGraphQueryRequest } from '@deepseek-ai/dsh-codegraph'

/** One scripted collected-stream reader over fixed text. */
function reader(text: string, lossy = false) {
  return { readFrom: () => ({ text, nextOffset: text.length, lossy }) }
}

/** A settled or abort-settled fake child; collect readers and terminate are inert. */
function fakeHandle(outcome: SubprocessOutcome, stdout = '', stderr = '', stdoutLossy = false): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: { stdout: reader(stdout, stdoutLossy), stderr: reader(stderr) },
    done: Promise.resolve(outcome),
    terminate: () => undefined,
    waitForExit: () => Promise.resolve(true),
  }
}

/** A handle whose outcome arrives only when the spec's abort signal fires. */
function abortSettledHandle(spec: SubprocessSpawnSpec): SubprocessHandle {
  const signal = spec.signal
  if (signal === undefined) throw new Error('test requires a spec signal')
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: { stdout: reader(''), stderr: reader('') },
    done: new Promise<SubprocessOutcome>((resolve) => {
      signal.addEventListener('abort', () => { resolve({ exitCode: null, signal: 'SIGTERM' }) })
    }),
    terminate: () => undefined,
    waitForExit: () => Promise.resolve(true),
  }
}

/** A spawner that records specs and answers from a queue of scripted handles. */
function recordingSpawner(respond: (spec: SubprocessSpawnSpec) => SubprocessHandle) {
  const specs: SubprocessSpawnSpec[] = []
  return { specs, spawn: (spec: SubprocessSpawnSpec) => { specs.push(spec); return respond(spec) } }
}

const spec: Astria.AstriaProviderSpec = {
  executable: '/bin/astria',
  args: ['--global'],
  env: { ASTRIA_EXTRA: '1' },
  llmEnv: {},
  semantic: {},
  extractionLabel: 'plain',
  maxOutputBytes: 1000,
  maxStderrBytes: 200,
  killGraceMs: 250,
}

const statsRequest: CodeGraphQueryRequest = { root: '/ws', query: { operation: 'stats' } }

describe('AstriaCliProvider.query', () => {
  it('spawns the resolved executable with global args and the built operation, then returns the report', async () => {
    const { specs, spawn } = recordingSpawner(() => fakeHandle({ exitCode: 0, signal: null }, 'nodes: 10'))
    const provider = new Astria.AstriaCliProvider(spec, spawn)
    await expect(provider.query(statsRequest)).resolves.toEqual({ kind: 'text', text: 'nodes: 10', truncated: false })
    expect(specs[0]).toMatchObject({
      argv: ['/bin/astria', '--global', 'stats', '--graph', '/ws'],
      cwd: '/ws',
      graceMs: 250,
      env: { ASTRIA_EXTRA: '1' },
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 1000 },
        stderr: { maxBytes: 200 },
      },
    })
  })

  it('marks a lossy stdout read as truncated', async () => {
    const { spawn } = recordingSpawner(() => fakeHandle({ exitCode: 0, signal: null }, 'tail', '', true))
    const provider = new Astria.AstriaCliProvider(spec, spawn)
    await expect(provider.query(statsRequest)).resolves.toEqual({ kind: 'text', text: 'tail', truncated: true })
  })

  it('returns an empty report when the handle exposes no collect readers', async () => {
    const bare = fakeHandle({ exitCode: 0, signal: null }, 'ignored')
    ;(bare as { collected: unknown }).collected = {}
    const { spawn } = recordingSpawner(() => bare)
    const provider = new Astria.AstriaCliProvider(spec, spawn)
    await expect(provider.query(statsRequest)).resolves.toEqual({ kind: 'text', text: '', truncated: false })
  })

  it('fails without a stderr tail when the handle exposes no collect readers', async () => {
    const bare = fakeHandle({ exitCode: 1, signal: null })
    ;(bare as { collected: unknown }).collected = {}
    const { spawn } = recordingSpawner(() => bare)
    const provider = new Astria.AstriaCliProvider(spec, spawn)
    await expect(provider.query(statsRequest)).rejects.toThrow('astria stats failed with exit code 1')
  })

  it('fails with CODEGRAPH_EXIT and the stderr tail on a non-zero exit', async () => {
    const { spawn } = recordingSpawner(() => fakeHandle({ exitCode: 2, signal: null }, '', 'extract failed'))
    const provider = new Astria.AstriaCliProvider(spec, spawn)
    await expect(provider.query(statsRequest)).rejects.toThrow(expect.objectContaining({ code: 'CODEGRAPH_EXIT' }))
    await expect(provider.query(statsRequest)).rejects.toThrow(/exit code 2/)
    await expect(provider.query(statsRequest)).rejects.toThrow(/extract failed/)
  })

  it('maps the missing-graph failure to CODEGRAPH_NO_GRAPH', async () => {
    const { spawn } = recordingSpawner(() => fakeHandle({ exitCode: 1, signal: null }, '', 'Error: Graph error: No graph found at .astria/db.sqlite'))
    const provider = new Astria.AstriaCliProvider(spec, spawn)
    await expect(provider.query(statsRequest)).rejects.toThrow(expect.objectContaining({ code: 'CODEGRAPH_NO_GRAPH' }))
  })

  it('normalizes the status JSON envelope into the stable freshness report', async () => {
    const envelope = JSON.stringify({
      status: 'stale',
      ageMinutes: 45,
      nodes: 120,
      edges: 340,
      communities: 9,
      files: 40,
      builtAt: '1790520977',
      astriaVersion: '1.0.5',
      extractionHashVersion: 'v9',
      currentExtractionHashVersion: 'v10',
      extractionOutdated: true,
    })
    const { specs, spawn } = recordingSpawner(() => fakeHandle({ exitCode: 0, signal: null }, envelope))
    const provider = new Astria.AstriaCliProvider(spec, spawn)
    const result = await provider.query({ root: '/ws', query: { operation: 'status' } })
    expect(specs[0]).toMatchObject({ argv: ['/bin/astria', '--global', 'status', '--json', '--graph', '/ws'] })
    expect(result.truncated).toBe(false)
    expect(result.text).toContain('Status: stale')
    expect(result.text).toContain('by astria 1.0.5')
    expect(result.text).toContain('Extraction rules: v9')
    expect(result.text).toContain('Extraction: plain')
  })

  it('appends the configured extraction mode to the normalized status report', async () => {
    const envelope = JSON.stringify({ status: 'fresh', ageMinutes: 2 })
    const { specs, spawn } = recordingSpawner(() => fakeHandle({ exitCode: 0, signal: null }, envelope))
    const provider = new Astria.AstriaCliProvider({
      ...spec,
      semantic: { backend: 'openai', judge: true },
      extractionLabel: 'openai + jev judge',
    }, spawn)
    const result = await provider.query({ root: '/ws', query: { operation: 'status' } })
    expect(specs[0]?.argv).toEqual(['/bin/astria', '--global', 'status', '--json', '--graph', '/ws'])
    expect(result.text.endsWith('\nExtraction: openai + jev judge')).toBe(true)
  })

  it('carries the semantic flags and the derived LLM env on refresh runs', async () => {
    const specs: SubprocessSpawnSpec[] = []
    const provider = new Astria.AstriaCliProvider({
      ...spec,
      semantic: { backend: 'claude', judge: true },
      llmEnv: { ASTRIA_LLM_BACKEND: 'claude', ASTRIA_LLM_JUDGE: 'jev', ASTRIA_LLM_API_KEY: 'sk-test' },
    }, (spawned) => {
      specs.push(spawned)
      return fakeHandle({ exitCode: 0, signal: null }, 'ok')
    })
    await provider.refresh({ root: '/ws', mode: 'update' })
    expect(specs[0]?.argv).toEqual(['/bin/astria', '--global', 'update', '/ws', '--backend', 'claude', '--judge', 'jev'])
    expect(specs[0]?.env).toMatchObject({
      ASTRIA_EXTRA: '1',
      ASTRIA_LLM_BACKEND: 'claude',
      ASTRIA_LLM_JUDGE: 'jev',
      ASTRIA_LLM_API_KEY: 'sk-test',
    })
  })

  it('maps a status envelope reporting a missing graph to CODEGRAPH_NO_GRAPH', async () => {
    const { spawn } = recordingSpawner(() => fakeHandle({ exitCode: 0, signal: null }, JSON.stringify({ status: 'missing' })))
    const provider = new Astria.AstriaCliProvider(spec, spawn)
    await expect(provider.query({ root: '/ws', query: { operation: 'status' } }))
      .rejects.toThrow(expect.objectContaining({ code: 'CODEGRAPH_NO_GRAPH' }))
  })

  it('passes status stdout through unchanged when it is not the JSON envelope', async () => {
    const { spawn } = recordingSpawner(() => fakeHandle({ exitCode: 0, signal: null }, 'Status: fresh (3 min ago)'))
    const provider = new Astria.AstriaCliProvider(spec, spawn)
    await expect(provider.query({ root: '/ws', query: { operation: 'status' } }))
      .resolves.toEqual({ kind: 'text', text: 'Status: fresh (3 min ago)', truncated: false })
  })

  it('names the terminating signal when there is no exit code', async () => {
    const { spawn } = recordingSpawner(() => fakeHandle({ exitCode: null, signal: 'SIGKILL' }))
    const provider = new Astria.AstriaCliProvider(spec, spawn)
    await expect(provider.query(statsRequest)).rejects.toThrow(/signal SIGKILL/)
  })

  it('rejects before spawning when the caller signal is already aborted', async () => {
    const { specs, spawn } = recordingSpawner(() => fakeHandle({ exitCode: 0, signal: null }))
    const provider = new Astria.AstriaCliProvider(spec, spawn)
    const controller = new AbortController()
    controller.abort()
    await expect(provider.query(statsRequest, controller.signal)).rejects.toThrow()
    expect(specs).toHaveLength(0)
  })

  it('surfaces the caller abort reason when the child is terminated mid-flight', async () => {
    const { spawn } = recordingSpawner(spec => abortSettledHandle(spec))
    const provider = new Astria.AstriaCliProvider(spec, spawn)
    const controller = new AbortController()
    const pending = provider.query(statsRequest, controller.signal)
    controller.abort(new Error('caller stopped waiting'))
    await expect(pending).rejects.toThrow('caller stopped waiting')
  })

  it('rejects new work after disposal (CODEGRAPH_DISPOSED)', async () => {
    const { spawn } = recordingSpawner(() => fakeHandle({ exitCode: 0, signal: null }))
    const provider = new Astria.AstriaCliProvider(spec, spawn)
    await provider.dispose()
    await expect(provider.query(statsRequest)).rejects.toThrow(expect.objectContaining({ code: 'CODEGRAPH_DISPOSED' }))
  })

  it('disposal aborts an in-flight child and awaits its settlement', async () => {
    const { spawn } = recordingSpawner(spec => abortSettledHandle(spec))
    const provider = new Astria.AstriaCliProvider(spec, spawn)
    const pending = provider.query(statsRequest)
    await provider.dispose()
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'CODEGRAPH_DISPOSED' }))
  })
})

/** A Subprocess service whose resolve and spawn behavior tests script directly. */
class FakeSubprocess extends SubprocessRuntime {
  constructor(ctx: Context, private readonly resolve: (signal?: AbortSignal) => Promise<string>) {
    super(ctx)
  }

  resolveExecutable(_command: string, _env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    return this.resolve(signal)
  }

  async terminalEnvironment() {
    return { platform: 'posix' as const }
  }

  spawn(_spec: SubprocessSpawnSpec): SubprocessHandle {
    return fakeHandle({ exitCode: 0, signal: null }, 'ok')
  }

  spawnTerminal(): never {
    throw new Error('terminal spawns are outside these tests')
  }
}

async function mountApply(resolve: (signal?: AbortSignal) => Promise<string>): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(CodeGraph)
  await ctx.plugin(class extends FakeSubprocess {
    constructor(context: Context) { super(context, resolve) }
  })
  await ctx.plugin(Astria, {})
  return ctx
}

describe('astria plugin apply', () => {
  it('resolves the executable, registers the sole provider, and answers through it', async () => {
    const ctx = await mountApply(() => Promise.resolve('/resolved/astria'))
    const codeGraph = ctx.codeGraph
    await expect(codeGraph.query(statsRequest)).resolves.toEqual({ kind: 'text', text: 'ok', truncated: false })
    await ctx.fiber.dispose()
    // Disposal unregistered the provider, so the next query reports the empty scope.
    await expect(codeGraph.query(statsRequest)).rejects.toThrow('no code-graph provider is registered')
  })

  it('rejects activation when the executable cannot be resolved', async () => {
    await expect(mountApply(() => Promise.reject(new Error('command not found'))))
      .rejects.toThrow('command not found')
  })

  it('aborts a hanging executable resolution when the plugin is disposed mid-activation', async () => {
    const ctx = new Context()
    await ctx.plugin(CodeGraph)
    await ctx.plugin(class extends FakeSubprocess {
      constructor(context: Context) {
        super(context, signal => new Promise((_, reject) => {
          signal?.addEventListener('abort', () => { reject(new Error('lookup aborted')) })
        }))
      }
    })
    const activation = ctx.plugin(Astria, {})
    const expectation = expect(activation).rejects.toThrow()
    await new Promise(resolve => setImmediate(resolve))
    await ctx.fiber.dispose()
    await expectation
  })

  it('rejects a non-positive byte cap at load', async () => {
    const ctx = new Context()
    await ctx.plugin(CodeGraph)
    await ctx.plugin(class extends FakeSubprocess {
      constructor(context: Context) { super(context, () => Promise.resolve('/resolved/astria')) }
    })
    await expect(ctx.plugin(Astria, { maxOutputBytes: 0 })).rejects.toThrow(/maxOutputBytes/)
  })

  it('rejects a fractional kill grace at load', async () => {
    const ctx = new Context()
    await ctx.plugin(CodeGraph)
    await ctx.plugin(class extends FakeSubprocess {
      constructor(context: Context) { super(context, () => Promise.resolve('/resolved/astria')) }
    })
    await expect(ctx.plugin(Astria, { killGraceMs: 0.5 })).rejects.toThrow(/killGraceMs/)
  })
})
