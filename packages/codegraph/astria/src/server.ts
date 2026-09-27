/**
 * The persistent `astria mcp` server: one pooled stdio child per workspace root, speaking
 * newline-delimited JSON-RPC (MCP) over the subprocess seam's piped streams. Six of the seam's query
 * operations map onto the server's tools; export and refresh deliberately stay on the one-shot CLI,
 * which the server does not offer. Server-initiated notifications are dropped and requests answered with
 * method-not-found so a chatty server cannot wedge the pipeline.
 * @module @deepseek-ai/dsh-astria/server
 */

import { CodeGraphError } from '@deepseek-ai/dsh-codegraph'
import type { CodeGraphQuery, CodeGraphQueryRequest, CodeGraphResult } from '@deepseek-ai/dsh-codegraph'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { AstriaSpawner } from './provider.ts'

export type { AstriaSpawner } from './provider.ts'

/** The persistent server's host bounds. */
export interface AstriaServerSpec {
  /** Canonical executable path resolved in this provider's execution world at load. */
  readonly executable: string
  /** Extra global arguments inserted between the executable and `mcp`. */
  readonly args: readonly string[]
  /** Explicit environment entries merged onto the spawner's scrubbed parent base. */
  readonly env: Readonly<Record<string, string>>
  /** Per-call budget for the MCP handshake and every tools/call (ms). */
  readonly callTimeoutMs: number
  /** Termination grace for disposal (ms). */
  readonly killGraceMs: number
  /** In-memory cap for collected stderr diagnostics (bytes). */
  readonly maxStderrBytes: number
}

/** The MCP protocol revision this client requests; servers negotiate their supported revision. */
const MCP_PROTOCOL_VERSION = '2025-06-18'

/** One MCP tools/call the seam's request maps onto. */
export interface McpToolCall {
  readonly name: string
  readonly arguments: Record<string, unknown>
}

/**
 * The query operations the pooled MCP server answers. `export` has no MCP tool and `status` is a
 * build-pipeline fact, not a served query — both run through the one-shot CLI, so they are excluded
 * from this mapping's domain.
 */
export type McpServedQuery = Exclude<CodeGraphQuery, { operation: 'export' } | { operation: 'status' }>

/**
 * Map one seam query onto the astria MCP server's tool vocabulary. Argument names match the seam's
 * refinement fields (`budget` carries the producer-derived token budget).
 * @param request - the normalized query plus workspace root; the query operation must be MCP-served.
 * @returns the server tool name and its arguments.
 */
export function mcpToolCall(request: CodeGraphQueryRequest & { readonly query: McpServedQuery }): McpToolCall {
  const { query } = request
  switch (query.operation) {
    case 'repoMap':
      return { name: 'repo_map', arguments: { budget: query.budgetTokens } }
    case 'query':
      return {
        name: 'query_graph',
        arguments: {
          question: query.question,
          ...query.depth !== undefined ? { depth: query.depth } : {},
          ...query.directed !== undefined ? { directed: query.directed } : {},
          ...query.cursor !== undefined ? { cursor: query.cursor } : {},
          ...query.budgetTokens !== undefined ? { budget: query.budgetTokens } : {},
        },
      }
    case 'explain':
      return { name: 'explain', arguments: { node: query.node } }
    case 'path':
      return {
        name: 'shortest_path',
        arguments: {
          source: query.source,
          target: query.target,
          ...query.directed !== undefined ? { directed: query.directed } : {},
        },
      }
    case 'affected':
      return {
        name: 'affected',
        arguments: {
          node: query.node,
          ...query.depth !== undefined ? { depth: query.depth } : {},
        },
      }
    case 'stats':
      return { name: 'graph_stats', arguments: {} }
    // Hub and community answers have been MCP tools since 1.0; the seam grew the operations when
    // astria 1.0.6 added CLI parity, so both transports now answer them.
    case 'hubs':
      return { name: 'god_nodes', arguments: {} }
    case 'communities':
      return { name: 'list_communities', arguments: {} }
    /* v8 ignore next -- exhaustive over the closed CodeGraphQuery union; unreachable. */
    default:
      return assertNever(query, 'astria mcp tool mapping')
  }
}

/** One live MCP server child: handshake done, calls correlated by id, disposal owned here. */
export class AstriaMcpServer {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private buffer = ''
  private settled = false

  private constructor(
    private readonly handle: SubprocessHandle,
    private readonly spec: AstriaServerSpec,
  ) {
    handle.stdout?.setEncoding('utf8')
    handle.stdout?.on('data', (chunk: string) => { this.onOutput(chunk) })
    handle.stdout?.on('end', () => { this.onTransportClosed() })
    handle.stdout?.on('error', () => { this.onTransportClosed() })
    // The child's own settlement closes the transport: a crashed or killed server rejects its
    // pending calls through the same path disposal takes.
    void handle.done.then(() => { this.onTransportClosed() }, () => { this.onTransportClosed() })
  }

  /** Whether this child can still serve calls; a dead server is never reused. */
  get dead(): boolean {
    return this.settled
  }

  /**
   * Spawn and initialize one server child for a workspace root.
   * @param spawn - the injected spawner (the subprocess seam).
   * @param spec - executable, bounds, and the per-call timeout budget.
   * @param root - the workspace root the server pins with `--graph`.
   * @returns the initialized server.
   * @throws CodeGraphError CODEGRAPH_EXIT when the child exits, the handshake times out, or the
   * server rejects initialization.
   */
  static async start(spawn: AstriaSpawner, spec: AstriaServerSpec, root: string): Promise<AstriaMcpServer> {
    const handle = spawn({
      argv: [spec.executable, ...spec.args, 'mcp', '--graph', root],
      cwd: root,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: spec.maxStderrBytes },
      },
      graceMs: spec.killGraceMs,
      signal: undefined,
      env: spec.env,
    })
    const server = new AstriaMcpServer(handle, spec)
    try {
      await server.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'dsh-astria', version: '0' },
      }, spec.callTimeoutMs)
      server.notify('notifications/initialized')
      return server
    } catch (error) {
      await server.dispose()
      throw error
    }
  }

  /**
   * Run one tool call and join its text content into the result union.
   * @param tool - the mapped tool name and arguments.
   * @param operation - the seam operation, for error attribution.
   * @returns the joined text result; MCP `isError` fails as CODEGRAPH_EXIT with the text.
   */
  async call(tool: McpToolCall, operation: string): Promise<CodeGraphResult> {
    const raw = await this.request('tools/call', { name: tool.name, arguments: tool.arguments }, this.spec.callTimeoutMs)
    const outcome = raw as { content?: Array<{ type?: string; text?: unknown }>; isError?: boolean }
    const text = (outcome.content ?? [])
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
    if (outcome.isError === true) {
      if (/No graph found/i.test(text)) {
        throw new CodeGraphError(text, 'CODEGRAPH_NO_GRAPH')
      }
      throw new CodeGraphError(`astria mcp ${operation} failed: ${text}`, 'CODEGRAPH_EXIT')
    }
    return { kind: 'text', text, truncated: false }
  }

  /** Terminate the child and settle every pending call. Idempotent. */
  async dispose(): Promise<void> {
    if (this.settled) return
    this.settled = true
    this.handle.terminate()
    this.handle.stdin?.end()
    await Promise.allSettled([this.handle.done, this.handle.waitForExit()])
    this.onTransportClosed()
  }

  /** Send one JSON-RPC request and await its correlated response under a deadline. */
  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.settled) {
      return Promise.reject(new CodeGraphError('astria mcp server is closed', 'CODEGRAPH_EXIT'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const settle = (error: Error | undefined, value?: unknown): void => {
        clearTimeout(timer)
        this.pending.delete(id)
        if (error !== undefined) reject(error)
        else resolve(value)
      }
      // Disposal or transport loss settles pending calls through onTransportClosed; the deadline
      // timer below owns the timeout wording.
      const timer = setTimeout(() => {
        // A call that outlives its budget leaves the server suspect; retire it so the next query
        // restarts fresh instead of stacking timeouts on a wedged child.
        void this.dispose()
        settle(new CodeGraphError(`astria mcp ${method} timed out after ${timeoutMs}ms`, 'CODEGRAPH_EXIT'))
      }, timeoutMs)
      this.pending.set(id, { resolve: (value) => { settle(undefined, value) }, reject: (error) => { settle(error) } })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** Send one JSON-RPC notification (no response expected). */
  private notify(method: string): void {
    this.send({ jsonrpc: '2.0', method })
  }

  /** Write one framed message; a closed stdin fails the whole transport. */
  private send(message: unknown): void {
    try {
      this.handle.stdin?.write(`${JSON.stringify(message)}\n`)
    } catch {
      this.onTransportClosed()
    }
  }

  /** Buffer stdout, split lines, and route each parsed JSON-RPC message. */
  private onOutput(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line === '') continue
      let message: { id?: unknown; method?: unknown; result?: unknown; error?: unknown }
      try {
        message = JSON.parse(line) as { id?: unknown; method?: unknown }
      } catch {
        // A non-JSON line is dropped: the server owns diagnostics on stderr, not stdout.
        continue
      }
      if (typeof message.id === 'number' && message.method !== undefined) {
        // Server-initiated requests get protocol-level method-not-found; notifications are dropped.
        this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
        continue
      }
      if (typeof message.id === 'number') {
        const waiter = this.pending.get(message.id)
        if (waiter === undefined) continue
        if (message.error !== undefined) {
          waiter.reject(new CodeGraphError(`astria mcp error: ${JSON.stringify(message.error)}`, 'CODEGRAPH_EXIT'))
        } else {
          waiter.resolve(message.result)
        }
      }
    }
  }

  /**
   * The transport ended: no further calls can be served or started. Pending calls reject with the
   * teardown error; the caller owns the attached handler — every caller in this package awaits the
   * call through the provider chain, so a rejection here is always delivered to a live reader.
   */
  private onTransportClosed(): void {
    if (this.settled) {
      for (const waiter of this.pending.values()) {
        waiter.reject(new CodeGraphError('astria mcp server is closed', 'CODEGRAPH_EXIT'))
      }
      this.pending.clear()
      return
    }
    this.settled = true
    for (const waiter of this.pending.values()) {
      waiter.reject(new CodeGraphError('astria mcp server exited unexpectedly', 'CODEGRAPH_EXIT'))
    }
    this.pending.clear()
  }
}
