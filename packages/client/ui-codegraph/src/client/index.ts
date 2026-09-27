/**
 * Code-graph tool row plugin, browser half: registers the `code_graph` keyed
 * toolview — a replay-stable accent row derived only from each logged
 * call/result slice — plus the action a settled export carries: the artifact's
 * bytes load through the session-authorized `workspaceFiles` remote and open
 * as a blob URL in a new tab, so the interactive page or static image renders
 * in the browser itself and the Client ships no graph renderer.
 */
// Type-only: pulls the Remote ctx merge (ctx.remote with its workspaceFiles namespace).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the session-scoped slot props merge (sessionId on the toolview runtime props).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { bindCodeGraphRow } from './CodeGraphRow.tsx'
import { en, NS, zh, type CodeGraphKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The dedicated code_graph tool row's copy. */
    codegraph: CodeGraphKey
  }
}

/** Required services: the tool-row, locale, and workspace-file remote faces. */
export const inject = ['slots', 'locale', 'remote', 'remote.workspaceFiles']

/** One opened view URL lives long enough for the new tab to load it. */
const VIEW_URL_LIFETIME_MS = 60_000

/**
 * Client plugin body: register the dictionaries and the keyed `code_graph` toolview.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-codegraph: dictionaries')
  const workspaceFiles = ctx.remote.workspaceFiles
  const openForSession = async (sessionId: SessionId, path: string, format: 'html' | 'svg'): Promise<void> => {
    const read = await workspaceFiles.readBytes(sessionId, path, {}, new AbortController().signal)
    if (!read.ok) throw read.error
    const url = URL.createObjectURL(new Blob([read.value.data], { type: format === 'html' ? 'text/html' : 'image/svg+xml' }))
    window.open(url, '_blank', 'noopener,noreferrer')
    setTimeout(() => { URL.revokeObjectURL(url) }, VIEW_URL_LIFETIME_MS)
  }
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'code_graph', locale: NS },
    bindCodeGraphRow(openForSession),
  ))
}
