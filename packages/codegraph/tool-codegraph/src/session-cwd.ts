/**
 * Derive the workspace root a `code_graph` call resolves against from the calling agent's session.
 * A missing cwd fails as `CODEGRAPH_WORKSPACE_REQUIRED` because the provider must query a real
 * workspace's graph.
 * @module @deepseek-ai/dsh-tool-codegraph/session-cwd
 */

import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/**
 * The session workspace cwd for this call, or `undefined` when none applies.
 * @param exec - the tool-execution context; only its optional `agent` is read.
 * @returns the calling agent's session cwd, or undefined for a non-agent caller.
 */
export function sessionCwd(exec: ToolExecution): string | undefined {
  return exec.agent?.session.header.cwd
}
