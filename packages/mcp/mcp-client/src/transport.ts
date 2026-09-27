/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing); Streamable HTTP connects to a URL, optionally through the
 * server's OAuth provider.
 *
 * @module
 */

import type { StreamableHTTPClientTransportOptions, Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { McpOAuthProvider } from './auth.ts'
import type { Config } from './index.ts'

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the spec's explicit env. The MCP SDK owns the
 * actual spawn, so this transport shares the scrub definition rather than the
 * spawn path.
 */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/**
 * Create an MCP transport from the resolved plugin config.
 *
 * With an OAuth provider the transport owns bearer injection, 401-driven
 * refresh, and the unauthorized refusal; the interactive half of the flow
 * stays with the authorization seam, which is why the provider refuses
 * (rather than stages) outside a sign-in attempt.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @param oauth - The configured server's OAuth provider, when `auth` is set.
 * @returns A connected-ready MCP Transport (stdio or Streamable HTTP).
 */
export function createTransport(config: Config, oauth?: McpOAuthProvider): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
    case 'streamable-http': {
      const options: StreamableHTTPClientTransportOptions = { requestInit: { headers: config.headers } }
      if (oauth !== undefined) options.authProvider = oauth
      return new StreamableHTTPClientTransport(new URL(config.url), options)
    }
  }
}
