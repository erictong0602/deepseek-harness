/**
 * One-origin OAuth fixture for the mcp-client auth suite: an authorization
 * server (RFC 9728 protected-resource metadata, RFC 8414 authorization-server
 * metadata, RFC 7591 dynamic registration, authorize with S256 PKCE, token
 * exchange and refresh) sharing its origin with a bearer-gated Streamable
 * HTTP MCP endpoint. Loopback origins keep the SDK's secure-token-endpoint
 * check satisfied without TLS.
 */

import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { z } from 'zod'

/** Running fixture and what it observed. */
export interface OAuthMcpFixture {
  /** The bearer-gated Streamable HTTP MCP endpoint. */
  url: string
  /** The authorization server origin, also the token issuer. */
  issuer: string
  /** Every `Authorization` header the MCP endpoint saw, in order. */
  seenBearers: Array<string | undefined>
  /** Every dynamic client registration body. */
  registrations: Array<Record<string, unknown>>
  /** Every token request body, keyed by grant type. */
  tokenRequests: Array<Record<string, string>>
  /** Invalidate the current access token, as an authorization server expiry would. */
  revokeAccess(): void
  close(): Promise<void>
}

/** One authorization code the fixture minted. */
interface IssuedCode {
  challenge: string
  redirectUri: string
  consumed: boolean
}

/** Sleep for a bounded wall-clock delay. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** S256 of a PKCE verifier, as the authorize request carries it. */
function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** Read one request's full body. */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString() })
    request.on('end', () => { resolve(body) })
    request.on('error', reject)
  })
}

/**
 * Start the combined authorization-server + gated MCP fixture. The endpoint
 * accepts exactly the newest access token any exchange or refresh minted, so
 * a rotated refresh token invalidates the old access token like a real one.
 */
export async function startOAuthMcpFixture(options: { slowDiscoveryMs?: number } = {}): Promise<OAuthMcpFixture> {
  const seenBearers: Array<string | undefined> = []
  const registrations: Array<Record<string, unknown>> = []
  const tokenRequests: Array<Record<string, string>> = []
  const codes = new Map<string, IssuedCode>()
  let currentAccessToken = 'token-0'
  let tokenCounter = 0

  const handler = createMcpHandler(() => {
    const mcp = new McpServer(
      { name: 'oauth-fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    mcp.registerTool('ping', { description: 'Replies pong.', inputSchema: z.object({}) }, async (): Promise<CallToolResult> => {
      return { content: [{ type: 'text', text: 'pong' }] }
    })
    return mcp
  })
  const mcpHandler = toNodeHandler(handler)

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', origin)
      const method = request.method ?? 'GET'

      if (url.pathname === '/mcp') {
        seenBearers.push(request.headers.authorization)
        if (request.headers.authorization !== `Bearer ${currentAccessToken}`) {
          response.writeHead(401, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null }))
          return
        }
        await mcpHandler(request as NodeIncomingMessageLike, response)
        return
      }

      if (url.pathname === '/.well-known/oauth-protected-resource' && method === 'GET') {
        if (options.slowDiscoveryMs !== undefined) await sleep(options.slowDiscoveryMs)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
        }))
        return
      }

      if (url.pathname === '/.well-known/oauth-authorization-server' && method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          authorization_response_iss_parameter_supported: true,
        }))
        return
      }

      if (url.pathname === '/register' && method === 'POST') {
        const body = JSON.parse(await readBody(request)) as Record<string, unknown>
        registrations.push(body)
        response.writeHead(201, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          client_id: 'fixture-client',
          client_name: body.client_name,
          redirect_uris: body.redirect_uris,
          grant_types: body.grant_types,
        }))
        return
      }

      if (url.pathname === '/authorize' && method === 'GET') {
        const redirectUri = url.searchParams.get('redirect_uri')
        const challenge = url.searchParams.get('code_challenge')
        const state = url.searchParams.get('state')
        if (redirectUri === null || challenge === null || state === null) {
          response.writeHead(400).end('missing authorize parameters')
          return
        }
        const code = `code-${codes.size + 1}`
        codes.set(code, { challenge, redirectUri, consumed: false })
        const redirect = new URL(redirectUri)
        redirect.searchParams.set('code', code)
        redirect.searchParams.set('state', state)
        redirect.searchParams.set('iss', origin)
        response.writeHead(302, { location: redirect.toString() })
        response.end()
        return
      }

      if (url.pathname === '/token' && method === 'POST') {
        const form = new URLSearchParams(await readBody(request))
        const body = Object.fromEntries(form.entries())
        tokenRequests.push(body)
        const grantType = body.grant_type
        if (grantType === 'authorization_code') {
          const issued = codes.get(body.code ?? '')
          const verifier = body.code_verifier ?? ''
          if (issued === undefined || issued.consumed
            || body.redirect_uri !== issued.redirectUri
            || s256(verifier) !== issued.challenge) {
            response.writeHead(400, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: 'invalid_grant' }))
            return
          }
          issued.consumed = true
        } else if (grantType === 'refresh_token') {
          if (body.refresh_token == null || !body.refresh_token.startsWith('refresh-')) {
            response.writeHead(400, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: 'invalid_grant' }))
            return
          }
        } else {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'unsupported_grant_type' }))
          return
        }
        tokenCounter += 1
        currentAccessToken = `token-${tokenCounter}`
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          access_token: currentAccessToken,
          token_type: 'Bearer',
          refresh_token: `refresh-${tokenCounter}`,
          expires_in: 3600,
          scope: body.scope ?? '',
        }))
        return
      }

      response.writeHead(404).end()
    })().catch((error: unknown) => {
      response.writeHead(500).end(String(error))
    })
  })
  const listening: PromiseWithResolvers<void> = Promise.withResolvers()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('OAuth MCP fixture has no TCP address')
  const origin = `http://127.0.0.1:${address.port}`
  return {
    url: `${origin}/mcp`,
    issuer: origin,
    seenBearers,
    registrations,
    tokenRequests,
    revokeAccess: () => { currentAccessToken = 'revoked' },
    close: async () => {
      await handler.close()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}
