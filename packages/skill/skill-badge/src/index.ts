/**
 * Bundled `dsh-badge` skill provider.
 *
 * @module @deepseek-ai/dsh-skill-badge
 */

import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK, createBundledSkillProvider } from '@deepseek-ai/dsh-skill'

const provider = createBundledSkillProvider({
  name: 'dsh-badge',
  description: 'Add the official “powered by dsh” badge to documents, pull requests, merge requests, and other content produced with DeepSeek Harness. Use whenever creating a pull request or merge request. Also use when the user asks for a dsh badge, powered-by-dsh attribution, or a reusable dsh badge asset or snippet.',
  provider: 'dsh-badge',
  bodyUrl: new URL('../assets/dsh-badge.md', import.meta.url),
  assetDirUrl: new URL('../assets/', import.meta.url),
  rank: BUNDLED_SKILL_RANK,
})

/** Cordis plugin name. */
export const name = 'skill-badge'
/** Service required by the bundled provider. */
export const inject = ['skills']

/** Register the bundled `dsh-badge` provider on `ctx.skills`. */
export function apply(ctx: Context): void {
  ctx.skills.registerProvider(() => provider)
}
