/**
 * Model-facing `code_graph` tool over `ctx.codeGraph`. One read-only tool with six operations
 * (`repoMap`/`query`/`explain`/`path`/`affected`/`stats`); it validates per-operation arguments,
 * requires the session workspace with no fallback, derives the provider's token budget from the
 * result-character cap, and caps and renders reports. It runtime-injects only `tools`, `codeGraph`,
 * and `systemPrompt` and imports no provider.
 *
 * Namespace plugin (named exports, no default export).
 * @module @deepseek-ai/dsh-tool-codegraph
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CodeGraphError } from '@deepseek-ai/dsh-codegraph'
import type { CodeGraphQuery } from '@deepseek-ai/dsh-codegraph'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  budgetForChars,
  CODEGRAPH_OPERATIONS,
  DEFAULT_MAX_RESULT_CHARS,
  formatReport,
  parseCodeGraphArgs,
  presentCodeGraphCall,
} from './render.ts'
import type { CodeGraphToolInput } from './render.ts'
import { sessionCwd } from './session-cwd.ts'

export {
  budgetForChars,
  CODEGRAPH_OPERATIONS,
  DEFAULT_MAX_RESULT_CHARS,
  formatReport,
  parseCodeGraphArgs,
  presentCodeGraphCall,
} from './render.ts'
export { sessionCwd } from './session-cwd.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-codegraph'

/** Services required by this plugin. */
export const inject = ['tools', 'codeGraph', 'systemPrompt']

/** Default tool-call timeout budget (ms), covering one complete provider child run. */
export const DEFAULT_CODEGRAPH_TOOL_TIMEOUT_MS = 60_000

/** The stable system-prompt guidance positioning the graph as a repository-level aid. */
export const CODEGRAPH_PROMPT_TEXT =
  'Use search/read for ordinary navigation and lsp for precise symbol positions. Use code_graph for repository-level structure: an overview map, how two areas connect, or what a change impacts. The graph is built outside this tool; if it is missing, the error explains how to build it.'

/** Plugin configuration: the result cap and the timeout budget. */
export interface Config {
  /** Largest complete rendered result in characters, including truncation metadata (default 16000). */
  maxResultChars?: number
  /** Tool-call timeout budget in ms (default 60000). */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  maxResultChars: z.number().default(DEFAULT_MAX_RESULT_CHARS),
  timeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_CODEGRAPH_TOOL_TIMEOUT_MS),
})

type ResolvedConfig = Required<Config>

/**
 * Register the `code_graph` tool and its system-prompt guidance.
 * @param ctx - the plugin context (must inject `tools`, `codeGraph`, `systemPrompt`).
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxResultChars', resolved.maxResultChars)
  assertTimer('timeoutMs', resolved.timeoutMs)

  ctx.systemPrompt.section({
    name: 'tool:code-graph',
    order: ctx.systemPrompt.getSectionOrder('TOOL_CODE_GRAPH'),
    text: CODEGRAPH_PROMPT_TEXT,
  })

  ctx.tools.register(defineTool({
    name: 'code_graph',
    description:
      'Query the repository code graph. operation is one of repoMap, query, explain, path, affected, stats. question is search terms for query; node is a symbol label or id for explain and affected; source and target are node labels for path. depth limits traversal hops; directed follows only caller-to-callee edges.',
    parameters: {
      operation: {
        type: 'string',
        required: true,
        enum: [...CODEGRAPH_OPERATIONS],
        description: 'repoMap, query, explain, path, affected, or stats.',
      },
      question: { type: 'string', description: 'query only: natural-language search terms.' },
      node: { type: 'string', description: 'explain and affected only: a symbol label, id, or source file path.' },
      source: { type: 'string', description: 'path only: the source node label.' },
      target: { type: 'string', description: 'path only: the target node label.' },
      depth: { type: 'number', description: 'query and affected only: traversal hop limit (positive integer).' },
      directed: { type: 'boolean', description: 'query and path only: follow only caller-to-callee edges.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'text' },
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        // The result union has one arm; field access here breaks compilation when a second arrives.
        return [{ type: 'text', text: formatReport(value.text, value.truncated, resolved.maxResultChars) }]
      },
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      const input = parseCodeGraphArgs(args)
      const root = sessionCwd(exec)
      if (root === undefined) {
        throw new CodeGraphError('the code_graph tool requires a session workspace cwd', 'CODEGRAPH_WORKSPACE_REQUIRED')
      }
      const result = await ctx.codeGraph.query(
        { root, query: buildSeamQuery(input, budgetForChars(resolved.maxResultChars)) },
        exec.signal,
      )
      // The result union has one arm; field access here breaks compilation when a second arrives.
      return { kind: 'text' as const, text: result.text, truncated: result.truncated }
    },
    presentCall: presentCodeGraphCall,
  }))
}

/** Build the seam query from validated input plus the derived token budget. */
function buildSeamQuery(input: CodeGraphToolInput, budgetTokens: number): CodeGraphQuery {
  switch (input.operation) {
    case 'repoMap':
      return { operation: 'repoMap', budgetTokens }
    case 'query':
      return {
        operation: 'query',
        question: input.question,
        ...input.depth !== undefined ? { depth: input.depth } : {},
        ...input.directed !== undefined ? { directed: input.directed } : {},
        budgetTokens,
      }
    case 'explain':
      return { operation: 'explain', node: input.node }
    case 'path':
      return {
        operation: 'path',
        source: input.source,
        target: input.target,
        ...input.directed !== undefined ? { directed: input.directed } : {},
      }
    case 'affected':
      return {
        operation: 'affected',
        node: input.node,
        ...input.depth !== undefined ? { depth: input.depth } : {},
      }
    case 'stats':
      return { operation: 'stats' }
  }
}

/** Reject a non-positive-integer config value at load, so misconfiguration fails loud. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-codegraph: ${name} must be a positive integer`)
  }
}

/** Reject a timer value Node would clamp instead of scheduling as configured. */
function assertTimer(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-codegraph: ${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}
