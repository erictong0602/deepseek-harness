/**
 * The server-transport provider: answers queries through one pooled `astria mcp` child per
 * workspace root (replacing a dead child transparently, once per query) while refresh and disposal
 * stay on the one-shot CLI discipline the {@link AstriaCliProvider} owns.
 * @module @deepseek-ai/dsh-astria/server-provider
 */

import { CodeGraphError, CodeGraphProviderId } from '@deepseek-ai/dsh-codegraph'
import type {
  CodeGraphProvider,
  CodeGraphQueryRequest,
  CodeGraphRefreshRequest,
  CodeGraphResult,
} from '@deepseek-ai/dsh-codegraph'
import { AstriaCliProvider } from './provider.ts'
import type { AstriaSpawner } from './provider.ts'
import { AstriaMcpServer, mcpToolCall } from './server.ts'
import type { AstriaServerSpec } from './server.ts'

/**
 * A `ctx.codeGraph` provider whose queries ride one persistent MCP server child per workspace
 * root. The pooled child removes the per-query process spawn; a transport that dies or times out is
 * replaced once before the failure reaches the caller.
 */
export class AstriaServerProvider implements CodeGraphProvider {
  readonly id: CodeGraphProviderId
  private readonly servers = new Map<string, AstriaMcpServer>()
  private readonly lifetime = new AbortController()
  private disposed = false

  constructor(
    private readonly cli: AstriaCliProvider,
    private readonly serverSpec: AstriaServerSpec,
    private readonly spawn: AstriaSpawner,
  ) {
    this.id = CodeGraphProviderId('astria')
  }

  /** Read the disposed flag through a method so a `query()` await cannot narrow it to a literal. */
  private isDisposed(): boolean {
    return this.disposed
  }

  private disposedError(): CodeGraphError {
    return new CodeGraphError('astria provider is disposed', 'CODEGRAPH_DISPOSED')
  }

  private assertActive(signal?: AbortSignal): void {
    if (this.isDisposed()) throw this.disposedError()
    signal?.throwIfAborted()
  }

  async query(request: CodeGraphQueryRequest, signal?: AbortSignal): Promise<CodeGraphResult> {
    this.assertActive(signal)
    const fused = signal === undefined
      ? this.lifetime.signal
      : AbortSignal.any([signal, this.lifetime.signal])
    const tool = mcpToolCall(request)
    let server = await this.serverFor(request.root)
    for (let attempt = 0; ; attempt++) {
      try {
        return await server.call(tool, request.query.operation)
      } catch (error) {
        fused.throwIfAborted()
        if (attempt > 0 || !server.dead) throw error
        // A dead transport is replaced once; a second consecutive failure is the caller's answer.
        server = await this.serverFor(request.root, true)
      }
    }
  }

  async refresh(request: CodeGraphRefreshRequest, signal?: AbortSignal): Promise<CodeGraphResult> {
    return this.cli.refresh(request, signal)
  }

  /** Return the pooled server for a root, replacing a dead slot when asked. */
  private async serverFor(root: string, replace = false): Promise<AstriaMcpServer> {
    const existing = this.servers.get(root)
    if (existing !== undefined && !existing.dead && !replace) return existing
    if (existing !== undefined) {
      this.servers.delete(root)
      await existing.dispose()
    }
    const started = await AstriaMcpServer.start(this.spawn, this.serverSpec, root)
    if (this.isDisposed()) {
      await started.dispose()
      throw this.disposedError()
    }
    this.servers.set(root, started)
    return started
  }

  /** Dispose every pooled server plus the CLI provider's in-flight children. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.lifetime.abort(this.disposedError())
    const live = [...this.servers.values()]
    this.servers.clear()
    await Promise.allSettled([...live.map(server => server.dispose()), this.cli.dispose()])
  }
}
