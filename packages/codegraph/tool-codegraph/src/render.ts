/**
 * Pure parsing, formatting, and presentation for the `code_graph` tool: per-operation argument
 * validation, complete-result character capping, and the generic call view. No I/O — a UI may call
 * the presenter on live streaming and on replay, so it depends only on the tool arguments.
 * @module @deepseek-ai/dsh-tool-codegraph/render
 */

import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { CODEGRAPH_OPERATIONS } from '@deepseek-ai/dsh-codegraph'
import type { CodeGraphOperation, CodeGraphQuery } from '@deepseek-ai/dsh-codegraph'

export { CODEGRAPH_OPERATIONS }

/** Default cap on the complete rendered tool result, including truncation metadata. */
export const DEFAULT_MAX_RESULT_CHARS = 16_000

/**
 * Validated `code_graph` arguments: the seam's query union with the producer-owned `budgetTokens`
 * arm field distributively removed, so each operation carries exactly its required subject plus
 * optional refinements and the two unions cannot drift apart.
 */
export type CodeGraphToolInput = ToolQueryOf<CodeGraphQuery>

/** Distributive `Omit`: apply the key removal to every arm of the query union. */
type ToolQueryOf<Q> = Q extends unknown ? Omit<Q, 'budgetTokens'> : never

/** The raw, schema-typed argument shape. */
export interface CodeGraphToolArgs {
  readonly operation: string
  readonly question?: string
  readonly node?: string
  readonly source?: string
  readonly target?: string
  readonly depth?: number
  readonly directed?: boolean
}

/**
 * Validate model arguments per operation: the subject field each operation requires must be a
 * non-empty string, and `depth` a positive integer.
 * @param args - the schema-validated raw arguments.
 * @returns the validated input; only the fields its operation uses are present.
 * @throws Error when the operation is unknown, a required subject is missing or blank, or `depth` is
 * not a positive integer.
 */
export function parseCodeGraphArgs(args: CodeGraphToolArgs): CodeGraphToolInput {
  if (!isOperation(args.operation)) {
    throw new Error(`operation must be one of ${CODEGRAPH_OPERATIONS.join(', ')}`)
  }
  switch (args.operation) {
    case 'repoMap':
    case 'stats':
      return { operation: args.operation }
    case 'query':
      return {
        operation: args.operation,
        question: requiredText(args.question, 'question'),
        ...depthField(args.depth),
        ...directedField(args.directed),
      }
    case 'explain':
      return { operation: args.operation, node: requiredText(args.node, 'node') }
    case 'path':
      return {
        operation: args.operation,
        source: requiredText(args.source, 'source'),
        target: requiredText(args.target, 'target'),
        ...directedField(args.directed),
      }
    case 'affected':
      return {
        operation: args.operation,
        node: requiredText(args.node, 'node'),
        ...depthField(args.depth),
      }
  }
}

/** Whether a string is one of the six operations. */
function isOperation(value: string): value is CodeGraphOperation {
  return (CODEGRAPH_OPERATIONS as readonly string[]).includes(value)
}

/** Require a non-blank string subject field. */
function requiredText(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}

/** Accept a positive-integer traversal depth, or omit the field entirely. */
function depthField(depth: number | undefined): { depth?: number } {
  if (depth === undefined) return {}
  if (!Number.isInteger(depth) || depth < 1) throw new Error('depth must be a positive integer')
  return { depth }
}

/** Accept the directed-edge flag, or omit the field entirely. */
function directedField(directed: boolean | undefined): { directed?: boolean } {
  return directed === undefined ? {} : { directed }
}

/**
 * Render a text report, applying `maxResultChars` last and keeping its marker within the cap. An
 * empty report renders a distinct no-output line; a provider-side truncation appends its marker
 * before the cap applies.
 * @param text - the seam's complete report text.
 * @param providerTruncated - whether the provider's own output bound kept only the tail.
 * @param maxResultChars - the complete rendered-text cap, including truncation metadata.
 * @returns the rendered report text.
 */
export function formatReport(text: string, providerTruncated: boolean, maxResultChars: number): string {
  const body = text.trim().length === 0 ? 'No output.' : text
  const marked = providerTruncated ? `${body}\n… output truncated by the provider (tail kept).` : body
  return boundResult(marked, maxResultChars)
}

/** Bound a complete rendered result, including the truncation notice itself. */
function boundResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const notice = `\n… report truncated (limit ${maxChars} characters).`
  if (notice.length >= maxChars) return notice.slice(0, maxChars)
  return `${text.slice(0, maxChars - notice.length)}${notice}`
}

/**
 * Derive the provider's token budget from the tool's complete-result character cap: roughly four
 * characters per token, floored at one.
 * @param maxResultChars - the complete rendered-text cap.
 * @returns the token budget passed as the query's `budgetTokens`.
 */
export function budgetForChars(maxResultChars: number): number {
  return Math.max(1, Math.floor(maxResultChars / 4))
}

/**
 * UI presentation for a pending `code_graph` call. A generic search card whose title carries the
 * operation and its subject; graph reports have no per-file locations to focus.
 * @param args - the raw tool arguments.
 * @returns the generic call view.
 */
export function presentCodeGraphCall(args: CodeGraphToolArgs): GenericCallView {
  const focus = args.question ?? args.node
    ?? (args.source !== undefined && args.target !== undefined ? `${args.source} -> ${args.target}` : args.operation)
  return {
    card: 'generic',
    kind: 'search',
    title: `code_graph ${args.operation} ${focus}`,
  }
}
