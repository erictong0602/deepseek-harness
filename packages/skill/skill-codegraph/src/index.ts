/**
 * Bundled `code-graph` skill provider: graph-first navigation guidance for repositories with an
 * `astria` knowledge graph, loaded on demand through the session skill catalog instead of spending
 * standing prompt tokens.
 *
 * @module @deepseek-ai/dsh-skill-codegraph
 */

import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, createBundledSkillProvider } from '@deepseek-ai/dsh-skill'

const provider = createBundledSkillProvider({
  name: 'code-graph',
  description: 'Navigate a repository through its astria knowledge graph: repo maps for orientation, natural-language architecture queries, blast-radius checks before risky edits, and cursor paging for deep results. Use when the code_graph tool is available and the question is about structure, connectivity, or change impact — not a single symbol\'s definition.',
  provider: 'dsh-codegraph',
  bodyUrl: new URL('../assets/code-graph.md', import.meta.url),
  assetDirUrl: new URL('../assets/', import.meta.url),
  rank: BUNDLED_SKILL_RANK,
})

/** Cordis plugin name. */
export const name = 'skill-codegraph'
/** Service required by the bundled provider. */
export const inject = ['skills']

/** Register the bundled `code-graph` skill provider on `ctx.skills`. */
export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
