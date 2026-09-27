/**
 * The shared shape of a bundled skill: one static candidate whose body is a packaged asset read at
 * invocation time, so the markdown file is the single source of truth every composition serves.
 * @module @deepseek-ai/dsh-skill/bundled
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { SkillCandidate, SkillDefinition, SkillProvider } from './index.ts'

/** The fixed inputs of one bundled skill. */
export interface BundledSkillOptions {
  /** The skill's catalog name (kebab-case). */
  readonly name: string
  /** The one-paragraph catalog description the model routes on. */
  readonly description: string
  /** The provider's stable identity. */
  readonly provider: string
  /** File URL of the skill's markdown body inside the package. */
  readonly bodyUrl: URL
  /** Directory URL the body's relative resources resolve against. */
  readonly assetDirUrl: URL
  /** The bundled rank (`BUNDLED_SKILL_RANK` from the package root). */
  readonly rank: number
  /** Invocation flags; bundled skills are model- and user-invocable. */
  readonly invocation?: { modelInvocable: boolean; userInvocable: boolean }
}

/**
 * Build the standard provider for one bundled skill: a static candidate plus a `get` that reads the
 * asset body at invocation time.
 * @param options - the skill's name, description, provider id, asset URLs, and rank.
 * @returns the provider to return from `ctx.skills.registerProvider`.
 */
export function createBundledSkillProvider(options: BundledSkillOptions): SkillProvider {
  const resourceBase = {
    kind: 'directory',
    path: fileURLToPath(options.assetDirUrl),
  } as const
  const invocation = options.invocation ?? { modelInvocable: true, userInvocable: true }
  const candidate: SkillCandidate = {
    name: options.name,
    description: options.description,
    invocation,
    provider: options.provider,
    source: 'bundled',
    resourceBase,
    rank: options.rank,
    locator: options.bodyUrl,
  }
  return {
    name: options.provider,
    list: () => Promise.resolve([candidate]),
    async get(_candidate): Promise<SkillDefinition> {
      return {
        name: options.name,
        description: options.description,
        invocation,
        provider: options.provider,
        source: 'bundled',
        resourceBase,
        content: await readFile(options.bodyUrl, 'utf8'),
      }
    },
  }
}
