/**
 * Model-facing `code_graph` tool over `ctx.codeGraph`. One read-only tool with ten operations
 * (`repoMap`/`query`/`explain`/`path`/`affected`/`stats`/`export`/`hubs`/`communities`/`status`);
 * it validates per-operation arguments, requires the session workspace with no fallback, derives the
 * provider's token budget from the result-character cap, and caps and renders reports. `export`
 * writes a viewable graph artifact under the workspace's `.astria` directory and reports its
 * workspace-relative path. It runtime-injects only `tools`, `codeGraph`, and `systemPrompt` and
 * imports no provider.
 *
 * Namespace plugin (named exports, no default export).
 * @module @deepseek-ai/dsh-tool-codegraph
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CodeGraphError, refreshJobHooks } from '@deepseek-ai/dsh-codegraph'
import type { CodeGraphExportFormat, CodeGraphQuery, CodeGraphRefreshMode, CodeGraphRefreshRequest, CodeGraphService } from '@deepseek-ai/dsh-codegraph'
import type { JobId, JobRegistry, JobSpec } from '@deepseek-ai/dsh-jobs'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  budgetForChars,
  codeGraphMetaFromValue,
  CODEGRAPH_TOOL_OPERATIONS,
  DEFAULT_MAX_RESULT_CHARS,
  formatReport,
  parseCodeGraphArgs,
  presentCodeGraphCall,
} from './render.ts'
import type { CodeGraphQueryInput } from './render.ts'
import { sessionCwd } from './session-cwd.ts'

export {
  budgetForChars,
  codeGraphMetaFromValue,
  CODEGRAPH_OPERATIONS,
  CODEGRAPH_TOOL_OPERATIONS,
  DEFAULT_MAX_RESULT_CHARS,
  formatReport,
  parseCodeGraphArgs,
  presentCodeGraphCall,
} from './render.ts'
export type { CodeGraphExportMeta, CodeGraphToolValue } from './render.ts'
export { sessionCwd } from './session-cwd.ts'

/** This producer's job kind on `ctx.jobs` (background graph builds and refreshes). */
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    codegraph: 'codegraph'
  }
}

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-codegraph'

/** Services required by this plugin. */
export const inject = ['tools', 'codeGraph', 'systemPrompt']

/** Default tool-call timeout budget (ms), covering one complete provider child run. */
export const DEFAULT_CODEGRAPH_TOOL_TIMEOUT_MS = 60_000

/** The stable system-prompt guidance positioning the graph as a repository-level aid. */
export const CODEGRAPH_PROMPT_TEXT =
  'Use search/read for ordinary navigation and lsp for precise symbol positions. Use code_graph for repository-level structure: an overview map, how two areas connect, or what a change impacts. The graph is built outside this tool; if it is missing, the error explains how to build it.'

/** Plugin configuration: the result cap, the timeout budget, and refresh gating. */
export interface Config {
  /** Largest complete rendered result in characters, including truncation metadata (default 16000). */
  maxResultChars?: number
  /** Tool-call timeout budget in ms (default 60000). */
  timeoutMs?: number
  /** Expose the build and update operations (default true); disabled calls fail loudly. */
  allowRefresh?: boolean
}

export const Config: z<Config> = z.object({
  maxResultChars: z.number().default(DEFAULT_MAX_RESULT_CHARS),
  timeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_CODEGRAPH_TOOL_TIMEOUT_MS),
  allowRefresh: z.boolean().default(true),
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
      'Query the repository code graph. operation is one of repoMap, query, explain, path, affected, stats, export, hubs, communities, status, build, update. question is search terms for query; node is a symbol label or id for explain and affected; source and target are node labels for path. depth limits traversal hops; directed follows only caller-to-callee edges; cursor continues a truncated query from its shown token. export writes a viewable graph artifact (format html or svg) and reports its path for the user to open; hubs lists the highest-degree hub nodes; communities lists detected communities; status reports graph freshness, build time, and tool versions. build and update rebuild the workspace graph as a background job and return the job id.',
    parameters: {
      operation: {
        type: 'string',
        required: true,
        enum: [...CODEGRAPH_TOOL_OPERATIONS],
        description: 'repoMap, query, explain, path, affected, stats, export, hubs, communities, status, build, or update.',
      },
      question: { type: 'string', description: 'query only: natural-language search terms.' },
      node: { type: 'string', description: 'explain and affected only: a symbol label, id, or source file path.' },
      source: { type: 'string', description: 'path only: the source node label.' },
      target: { type: 'string', description: 'path only: the target node label.' },
      depth: { type: 'number', description: 'query and affected only: traversal hop limit (positive integer).' },
      directed: { type: 'boolean', description: 'query and path only: follow only caller-to-callee edges.' },
      cursor: { type: 'number', description: 'query only: continuation token shown by a previous truncated result; fetches the next slice.' },
      format: { type: 'string', enum: ['html', 'svg'], description: 'export only: html interactive page (default) or svg static image.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'export' },
              format: { type: 'string', required: true, enum: ['html', 'svg'] },
              path: { type: 'string', required: true },
              text: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'text' },
              text: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' },
              jobId: { type: 'string', required: true },
            },
          },
        ],
      },
      render: (_args, value) => {
        switch (value.kind) {
          case 'text':
            return [{ type: 'text', text: formatReport(value.text, value.truncated, resolved.maxResultChars) }]
          case 'background':
            return [{ type: 'text', text: `started background job ${value.jobId}` }]
          case 'export': {
            const confirmation = value.text.trim() === '' ? '' : `${value.text.trim()}\n`
            return [{
              type: 'text',
              text: formatReport(`${confirmation}graph view artifact: ${value.path}`, value.truncated, resolved.maxResultChars),
            }]
          }
        }
      },
      presentationMeta: (_args, value) => codeGraphMetaFromValue(value),
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      const input = parseCodeGraphArgs(args)
      const root = sessionCwd(exec)
      if (root === undefined) {
        throw new CodeGraphError('the code_graph tool requires a session workspace cwd', 'CODEGRAPH_WORKSPACE_REQUIRED')
      }
      if (input.operation === 'build' || input.operation === 'update') {
        const mode = input.operation
        if (!resolved.allowRefresh) {
          throw new CodeGraphError(`the ${mode} operation is disabled for this deployment (allowRefresh: false)`, 'CODEGRAPH_REFRESH_DISABLED')
        }
        const jobs = ctx.get('jobs')
        // Builds run minutes, so an available registry plus an owning agent takes them off the turn;
        // otherwise the call runs in the foreground under the timeout budget.
        if (jobs !== undefined && exec.agent !== undefined) {
          exec.signal.throwIfAborted()
          return { kind: 'background' as const, jobId: startRefreshJob(jobs, ctx.codeGraph, root, mode, exec.agent.id) }
        }
        const refreshed = await ctx.codeGraph.refresh({ root, mode }, exec.signal)
        // The result union has one arm; field access here breaks compilation when a second arrives.
        return { kind: 'text' as const, text: refreshed.text, truncated: refreshed.truncated }
      }
      try {
        if (input.operation === 'export') {
          const target = exportArtifactTarget(root, input.format)
          const result = await ctx.codeGraph.query(
            { root, query: { operation: 'export', format: input.format, out: target.out } },
            exec.signal,
          )
          return { kind: 'export' as const, format: input.format, path: target.path, text: result.text, truncated: result.truncated }
        }
        const result = await ctx.codeGraph.query(
          { root, query: buildSeamQuery(input, budgetForChars(resolved.maxResultChars)) },
          exec.signal,
        )
        // The result union has one arm; field access here breaks compilation when a second arrives.
        return { kind: 'text' as const, text: result.text, truncated: result.truncated }
      } catch (error) {
        // A missing graph never dead-ends the call: start the build off the turn and say when to
        // retry. Without a registry (or with refresh disabled) the error reaches the model as-is.
        if (error instanceof CodeGraphError && error.code === 'CODEGRAPH_NO_GRAPH' && resolved.allowRefresh) {
          const jobs = ctx.get('jobs')
          if (jobs !== undefined && exec.agent !== undefined && !exec.signal.aborted) {
            const jobId = startRefreshJob(jobs, ctx.codeGraph, root, 'build', exec.agent.id)
            return {
              kind: 'text' as const,
              text: `No graph found for the workspace; started background job ${jobId} (astria build). Wait for the job to finish, then retry this query.`,
              truncated: false,
            }
          }
        }
        throw error
      }
    },
    presentCall: presentCodeGraphCall,
  }))
}

/**
 * Register one background graph refresh and return its job id. The job ends `completed` when the
 * refresh settles, `killed` when cancelled, and `failed` with the provider's message otherwise.
 */
function startRefreshJob(
  jobs: JobRegistry,
  codeGraph: Pick<CodeGraphService, 'refresh'>,
  root: string,
  mode: CodeGraphRefreshMode,
  owner: NonNullable<JobSpec['owner']>,
): JobId {
  const cancel = new AbortController()
  return jobs.start({
    kind: 'codegraph',
    label: `astria ${mode} ${root}`,
    owner,
    run: () => refreshJobHooks(codeGraph.refresh({ root, mode } satisfies CodeGraphRefreshRequest, cancel.signal), cancel, {
      completedDetail: `graph ${mode === 'build' ? 'built' : 'updated'}`,
    }),
  })
}

/**
 * The export artifact's placement: one deterministic file per workspace and format, so a replayed
 * card names the artifact the run wrote and a rebuild replaces it in place.
 */
export interface CodeGraphExportTarget {
  /** Absolute destination passed as the CLI's `--out`, joined in the execution world's syntax. */
  readonly out: string
  /** Workspace-relative POSIX path, persisted for clients and reported to the model. */
  readonly path: string
}

/**
 * Resolve the export artifact's deterministic placement under the workspace's astria state
 * directory: `<root>/.astria/graph-view.<format>`. The directory exists whenever a graph does, so a
 * successful export never needs to create it.
 * @param root - the session workspace root the graph was built for.
 * @param format - the viewable artifact format.
 * @returns the absolute CLI destination and the workspace-relative POSIX path.
 */
export function exportArtifactTarget(root: string, format: CodeGraphExportFormat): CodeGraphExportTarget {
  return {
    out: join(root, '.astria', `graph-view.${format}`),
    path: `.astria/graph-view.${format}`,
  }
}

/** Build the seam query from validated input plus the derived token budget. */
function buildSeamQuery(
  input: Exclude<CodeGraphQueryInput, { operation: 'export' }>,
  budgetTokens: number,
): CodeGraphQuery {
  switch (input.operation) {
    case 'repoMap':
      return { operation: 'repoMap', budgetTokens }
    case 'query':
      return {
        operation: 'query',
        question: input.question,
        ...input.depth !== undefined ? { depth: input.depth } : {},
        ...input.directed !== undefined ? { directed: input.directed } : {},
        ...input.cursor !== undefined ? { cursor: input.cursor } : {},
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
    case 'hubs':
      return { operation: 'hubs' }
    case 'communities':
      return { operation: 'communities' }
    case 'status':
      return { operation: 'status' }
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
