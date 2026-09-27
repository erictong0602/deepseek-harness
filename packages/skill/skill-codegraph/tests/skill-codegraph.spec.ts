import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillCodegraph from '@deepseek-ai/dsh-skill-codegraph'

describe('dsh-skill-codegraph', () => {
  it('registers and disposes the bundled code-graph skill', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(SkillCodegraph)
    const resourcePath = fileURLToPath(new URL('../assets/', import.meta.url))

    expect(await ctx.skills.list()).toEqual([{
      name: 'code-graph',
      description: 'Navigate a repository through its astria knowledge graph: repo maps for orientation, natural-language architecture queries, blast-radius checks before risky edits, and cursor paging for deep results. Use when the code_graph tool is available and the question is about structure, connectivity, or change impact — not a single symbol\'s definition.',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-codegraph',
      source: 'bundled',
      resourceBase: { kind: 'directory', path: resourcePath },
    }])
    const loaded = await ctx.skills.get('code-graph')
    expect(loaded?.content).toBe(await readFile(new URL('../assets/code-graph.md', import.meta.url), 'utf8'))
    expect(loaded?.content).toContain('Check the blast radius before risky edits')
    expect(loaded?.resourceBase).toEqual({ kind: 'directory', path: resourcePath })

    await fiber.dispose()
    expect(await ctx.skills.list()).toEqual([])
  })
})
