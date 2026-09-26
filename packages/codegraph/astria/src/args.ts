/**
 * Pure astria argv construction: maps one normalized seam request onto the astria CLI's subcommand
 * and flags. No I/O, no executable knowledge — the provider prepends the resolved executable and any
 * configured global arguments.
 * @module @deepseek-ai/dsh-astria/args
 */

import type { CodeGraphQueryRequest } from '@deepseek-ai/dsh-codegraph'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/**
 * Build the astria CLI arguments for one seam request. `--graph <root>` always pins the queried
 * workspace; refinement flags appear only when the request sets them.
 * @param request - the normalized query plus workspace root.
 * @returns the argv tail following the executable (and any configured global arguments).
 */
export function buildAstriaArgs(request: CodeGraphQueryRequest): string[] {
  const { root, query } = request
  switch (query.operation) {
    case 'repoMap':
      return ['map', '--graph', root, ...budgetArgs(query.budgetTokens)]
    case 'query':
      return [
        'query', query.question, '--graph', root,
        ...query.depth !== undefined ? ['--depth', String(query.depth)] : [],
        ...query.directed ? ['--directed'] : [],
        ...budgetArgs(query.budgetTokens),
      ]
    case 'explain':
      return ['explain', query.node, '--graph', root]
    case 'path':
      return [
        'path', query.source, query.target, '--graph', root,
        ...query.directed ? ['--directed'] : [],
      ]
    case 'affected':
      return [
        'affected', query.node, '--graph', root,
        ...query.depth !== undefined ? ['--depth', String(query.depth)] : [],
      ]
    case 'stats':
      return ['stats', '--graph', root]
    /* v8 ignore next -- exhaustive over the closed CodeGraphQuery union; unreachable. */
    default:
      return assertNever(query, 'astria query')
  }
}

/** Spread the token-budget flag only when the request set one. */
function budgetArgs(budgetTokens: number | undefined): string[] {
  return budgetTokens === undefined ? [] : ['--budget', String(budgetTokens)]
}
