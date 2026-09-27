/**
 * Shared fakes for the astria provider suites: a settled collect-mode child handle, and a scripted
 * pipe-mode child that speaks just enough newline JSON-RPC to stand in for `astria mcp`.
 */

import { PassThrough, Writable } from 'node:stream'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'

/** One scripted collected-stream reader over fixed text. */
export function reader(text: string, lossy = false) {
  return { readFrom: () => ({ text, nextOffset: text.length, lossy }) }
}

/** A settled fake child; collect readers and terminate are inert. */
export function fakeHandle(outcome: SubprocessOutcome, stdout = '', stderr = '', stdoutLossy = false): SubprocessHandle {
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

/** How the scripted MCP child answers one incoming JSON-RPC method. */
export type McpScript = (message: { id?: number; method?: string; params?: unknown }) => void

/** A pipe-mode child fake: records writes, answers through the script, and can die on demand. */
export class FakeMcpChild {
  readonly stdout = new PassThrough()
  readonly stdin = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim() === '') continue
        const message = JSON.parse(line) as { id?: number; method?: string; params?: unknown }
        this.received.push(message)
        this.script(message)
      }
      callback()
    },
  })
  readonly received: Array<{ id?: number; method?: string; params?: unknown }> = []
  private terminated = false

  constructor(private readonly script: McpScript) {}

  /** Push one server→client message. */
  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  /** Answer one request by id. */
  reply(id: number, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result })
  }

  /** Fail one request by id. */
  fail(id: number, error: unknown): void {
    this.send({ jsonrpc: '2.0', id, error })
  }

  /** The transport ended: no more messages can arrive. */
  close(): void {
    this.stdout.end()
  }

  /** Whether terminate() was called. */
  get wasTerminated(): boolean {
    return this.terminated
  }

  /** The subprocess handle view of this child. */
  handle(stderrText = ''): SubprocessHandle {
    return {
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: undefined,
      control: undefined,
      collected: { stderr: reader(stderrText) },
      done: new Promise<SubprocessOutcome>((resolve) => {
        this.stdout.on('close', () => { resolve({ exitCode: this.terminated ? null : 0, signal: this.terminated ? 'SIGTERM' : null }) })
      }),
      terminate: () => { this.terminated = true; this.stdout.end() },
      waitForExit: () => Promise.resolve(true),
    }
  }
}
