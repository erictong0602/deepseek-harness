/**
 * Real-binary end-to-end for the astria provider. Self-skips when the `astria` executable is not
 * resolvable, matching the repo's provider-testing discipline: the unit suites own the contract
 * against fakes, and this spec proves the argv, exit, and text plumbing against the real CLI.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CodeGraph from '@deepseek-ai/dsh-codegraph'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as Astria from '@deepseek-ai/dsh-astria'

/** Whether the real astria CLI resolves on this machine's PATH. */
async function resolveAstria(): Promise<string | undefined> {
  const ctx = new Context()
  try {
    await ctx.plugin(LocalSubprocessRuntime)
    return await ctx.subprocess.resolveExecutable('astria')
  } catch {
    return undefined
  } finally {
    await ctx.fiber.dispose()
  }
}

const executable = await resolveAstria()

describe.skipIf(executable === undefined)('astria provider against the real CLI', () => {
  it('builds a graph for a fresh workspace and answers repository queries', { timeout: 120_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-astria-e2e-'))
    try {
      await writeFile(join(root, 'sample.ts'), 'export function greet(name: string): string {\n  return `hello ${name}`\n}\n')
      const ctx = new Context()
      await ctx.plugin(CodeGraph)
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(Astria, {})
      await expect(ctx.codeGraph.refresh({ root, mode: 'build' })).resolves.toMatchObject({ kind: 'text', truncated: false })
      const stats = await ctx.codeGraph.query({ root, query: { operation: 'stats' } })
      expect(stats.text.trim().length).toBeGreaterThan(0)
      const repoMap = await ctx.codeGraph.query({ root, query: { operation: 'repoMap', budgetTokens: 100 } })
      expect(repoMap.text).toContain('sample.ts')
      // The normalized status report names the configured extraction mode (plain by default).
      const status = await ctx.codeGraph.query({ root, query: { operation: 'status' } })
      expect(status.text).toContain('Status: ')
      expect(status.text).toContain('\nExtraction: plain')
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
