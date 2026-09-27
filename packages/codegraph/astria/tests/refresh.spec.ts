import { describe, expect, it } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import * as Astria from '@deepseek-ai/dsh-astria'
import type { JobHooks, JobId, JobOutcome, JobRegistry, JobSpec } from '@deepseek-ai/dsh-jobs'

/** One scripted collected-stream reader over fixed text. */
function reader(text: string) {
  return { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) }
}

/** A settled fake child; collect readers and terminate are inert. */
function fakeHandle(outcome: SubprocessOutcome, stdout = '', stderr = ''): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: { stdout: reader(stdout), stderr: reader(stderr) },
    done: Promise.resolve(outcome),
    terminate: () => undefined,
    waitForExit: () => Promise.resolve(true),
  }
}

const providerSpec: Astria.AstriaProviderSpec = {
  executable: '/bin/astria',
  args: [],
  env: {},
  maxOutputBytes: 1000,
  maxStderrBytes: 200,
  killGraceMs: 250,
}

describe('AstriaCliProvider.refresh', () => {
  it('runs the full pipeline for build with the graph root', async () => {
    const specs: SubprocessSpawnSpec[] = []
    const provider = new Astria.AstriaCliProvider(providerSpec, (spawned) => {
      specs.push(spawned)
      return fakeHandle({ exitCode: 0, signal: null }, 'nodes: 3')
    })
    await expect(provider.refresh({ root: '/ws', mode: 'build' })).resolves.toEqual({ kind: 'text', text: 'nodes: 3', truncated: false })
    expect(specs[0]).toMatchObject({ argv: ['/bin/astria', 'run', '--graph', '/ws'], cwd: '/ws' })
  })

  it('runs the incremental pass for update', async () => {
    const specs: SubprocessSpawnSpec[] = []
    const provider = new Astria.AstriaCliProvider(providerSpec, (spawned) => {
      specs.push(spawned)
      return fakeHandle({ exitCode: 0, signal: null }, 'updated')
    })
    await provider.refresh({ root: '/ws', mode: 'update' })
    expect(specs[0]?.argv).toEqual(['/bin/astria', 'update', '--graph', '/ws'])
  })

  it('fails with the stderr tail when the build breaks', async () => {
    const provider = new Astria.AstriaCliProvider(providerSpec, () => fakeHandle({ exitCode: 2, signal: null }, '', 'extract failed'))
    await expect(provider.refresh({ root: '/ws', mode: 'build' })).rejects.toThrow(/astria graph build failed with exit code 2: extract failed/)
  })

  it('rejects refresh after disposal (CODEGRAPH_DISPOSED)', async () => {
    const provider = new Astria.AstriaCliProvider(providerSpec, () => fakeHandle({ exitCode: 0, signal: null }))
    await provider.dispose()
    await expect(provider.refresh({ root: '/ws', mode: 'update' })).rejects.toThrow(expect.objectContaining({ code: 'CODEGRAPH_DISPOSED' }))
  })
})

/** A registry double that records specs and issues fixed ids. */
type RecordingRegistry = JobRegistry & { specs: JobSpec[] }

function fakeRegistry(): RecordingRegistry {
  const specs: JobSpec[] = []
  const registry = {
    specs,
    start(spec: JobSpec): JobId {
      specs.push(spec)
      return 'codegraph-1' as JobId
    },
  }
  return registry as unknown as RecordingRegistry
}

/** The handle the registry hands one producer. */
function jobFace(): Parameters<JobSpec['run']>[0] {
  return { id: 'codegraph-1' as JobId, append: () => undefined, updateProgress: () => undefined }
}

/** A minimal agent double: its id fences the job, and inject records (or rejects) notices. */
type RecordingAgent = NonNullable<Parameters<typeof Astria.startUpdateJob>[3]> & { notices: unknown[] }

function fakeAgent(options: { injectThrows?: boolean } = {}): RecordingAgent {
  const notices: unknown[] = []
  return {
    id: 'session-1',
    notices,
    inject(notice: unknown): void {
      if (options.injectThrows) throw new Error('agent disposed')
      notices.push(notice)
    },
  } as unknown as RecordingAgent
}

describe('startUpdateJob', () => {
  it('registers an owned incremental-refresh job and notifies the agent on completion', async () => {
    const registry = fakeRegistry()
    const provider = new Astria.AstriaCliProvider(providerSpec, () => fakeHandle({ exitCode: 0, signal: null }, 'updated'))
    const agent = fakeAgent()
    Astria.startUpdateJob(registry, provider, '/ws', agent)
    expect(registry.specs[0]).toMatchObject({ kind: 'codegraph', label: 'astria update /ws', owner: 'session-1' })
    const hooks = registry.specs[0]!.run(jobFace())
    await expect(hooks.done).resolves.toEqual({ status: 'completed', detail: 'graph updated' } satisfies JobOutcome)
    expect(agent.notices).toHaveLength(1)
  })

  it('maps a failed refresh to a failed outcome without a notice', async () => {
    const registry = fakeRegistry()
    const provider = new Astria.AstriaCliProvider(providerSpec, () => fakeHandle({ exitCode: 3, signal: null }, '', 'boom'))
    const agent = fakeAgent()
    Astria.startUpdateJob(registry, provider, '/ws', agent)
    const hooks = registry.specs[0]!.run(jobFace())
    await expect(hooks.done).resolves.toMatchObject({ status: 'failed', detail: expect.stringContaining('boom') })
    expect(agent.notices).toHaveLength(0)
  })

  it('maps cancellation to a killed outcome', async () => {
    const registry = fakeRegistry()
    // The child settles only when the spawn spec's abort signal fires, as the real seam would.
    const provider = new Astria.AstriaCliProvider(providerSpec, spawned => ({
      ...fakeHandle({ exitCode: 0, signal: null }),
      done: new Promise<SubprocessOutcome>((resolve) => {
        spawned.signal?.addEventListener('abort', () => { resolve({ exitCode: null, signal: 'SIGTERM' }) })
      }),
    }))
    const agent = fakeAgent()
    Astria.startUpdateJob(registry, provider, '/ws', agent)
    const hooks = registry.specs[0]!.run(jobFace())
    hooks.cancel('job killed')
    await expect(hooks.done).resolves.toEqual({ status: 'killed', detail: 'cancelled' } satisfies JobOutcome)
  })

  it('treats a reason-less cancellation as a plain kill', async () => {
    const registry = fakeRegistry()
    const provider = new Astria.AstriaCliProvider(providerSpec, spawned => ({
      ...fakeHandle({ exitCode: 0, signal: null }),
      done: new Promise<SubprocessOutcome>((resolve) => {
        spawned.signal?.addEventListener('abort', () => { resolve({ exitCode: null, signal: 'SIGTERM' }) })
      }),
    }))
    const agent = fakeAgent()
    Astria.startUpdateJob(registry, provider, '/ws', agent)
    const hooks = registry.specs[0]!.run(jobFace())
    hooks.cancel()
    await expect(hooks.done).resolves.toEqual({ status: 'killed', detail: 'cancelled' } satisfies JobOutcome)
  })

  it('stringifies a non-Error refresh failure in the failed outcome', async () => {
    const registry = fakeRegistry()
    const provider = {
      refresh: () => Promise.reject('disk full'),
    } as unknown as Astria.AstriaCliProvider
    const agent = fakeAgent()
    Astria.startUpdateJob(registry, provider, '/ws', agent)
    const hooks = registry.specs[0]!.run(jobFace()) as JobHooks
    await expect(hooks.done).resolves.toMatchObject({ status: 'failed', detail: 'disk full' })
  })

  it('completes even when the owning agent was disposed before the notice', async () => {
    const registry = fakeRegistry()
    const provider = new Astria.AstriaCliProvider(providerSpec, () => fakeHandle({ exitCode: 0, signal: null }))
    const agent = fakeAgent({ injectThrows: true })
    Astria.startUpdateJob(registry, provider, '/ws', agent)
    const hooks = registry.specs[0]!.run(jobFace())
    await expect(hooks.done).resolves.toMatchObject({ status: 'completed' })
    expect(agent.notices).toHaveLength(0)
  })
})
