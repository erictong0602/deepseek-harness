/**
 * Loader export-shape guard for @deepseek-ai/dsh-tool-codegraph. It is a NAMESPACE plugin with
 * `inject`, so a stray `export default apply` would make the Loader's `unwrapExports` collapse the
 * module to the bare `apply`, dropping `inject` (postmortem 0001). This verifies the namespace
 * survives `Loader.prototype.unwrapExports`.
 */

import { describe, expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as toolCodeGraph from '@deepseek-ai/dsh-tool-codegraph'

describe('dsh-tool-codegraph Loader export-shape guard', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in toolCodeGraph).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolCodeGraph) as Record<string, unknown>
    expect(unwrapped).toBe(toolCodeGraph)
    expect(unwrapped.name).toBe('tool-codegraph')
    expect(unwrapped.inject).toEqual(['tools', 'codeGraph', 'systemPrompt'])
    expect(typeof unwrapped.apply).toBe('function')
    expect(unwrapped.Config).toBeDefined()
  })
})
