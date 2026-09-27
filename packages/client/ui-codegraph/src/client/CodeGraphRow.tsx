/** The `code_graph` tool call row with its viewable-artifact action. */
import { useState } from 'react'
import { DisclosureRow, IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { resultText, type ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './CodeGraphRow.module.css'
import type { NS } from './locales.ts'

/** Opens one exported artifact: resolves its bytes and hands the blob URL to a new tab. */
export type OpenGraphView = (path: string, format: 'html' | 'svg') => Promise<void>

type CodeGraphRowProps = ToolCallViewProps & PropsLocale<typeof NS> & { readonly openView: OpenGraphView }

/** Distributive `Omit`: keep the phase-tagged prop union when removing the bound opener. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never
type BoundCodeGraphRowProps = DistributiveOmit<CodeGraphRowProps, 'openView'>

/** Row lifecycle derived solely from the durable call slice. */
type CodeGraphRowState = 'running' | 'ok' | 'error' | 'stopped'

/** The settled result's export facts, narrowed from persisted `meta`. */
interface GraphViewTarget {
  readonly format: 'html' | 'svg'
  readonly path: string
}

/** Compact, replay-stable view model for the dedicated row. */
interface CodeGraphRowModel {
  readonly state: CodeGraphRowState
  /** One-line subject summary from the call arguments. */
  readonly subject: string
  /** Flattened result text; null while running or when the result carries no text. */
  readonly output: string | null
  readonly errorSummary: string | null
  readonly view: GraphViewTarget | null
}

/** First physical line for the collapsed error summary. */
function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/** The call's subject: the operation plus the argument that names what it targeted. */
function subjectOf(argsRaw: string, callId: string): string {
  let args: unknown
  try { args = JSON.parse(argsRaw) }
  catch { return argsRaw === '' ? callId : firstLine(argsRaw) }
  if (typeof args !== 'object' || args === null) return callId
  const { operation, question, node, source, target, format } = args as Record<string, unknown>
  if (typeof operation !== 'string' || operation === '') return callId
  const focus = typeof question === 'string' && question !== '' ? question
    : typeof node === 'string' && node !== '' ? node
      : typeof source === 'string' && typeof target === 'string' && source !== '' ? `${source} -> ${target}`
        : typeof format === 'string' && format !== '' ? format
          : undefined
  return focus === undefined ? operation : `${operation} ${firstLine(focus)}`
}

/** Flatten one settled result block under the generic Tool-row text contract (ui-tool's resultText). */
function settledResultText(block: Exclude<ToolCallViewProps['block'], { phase: 'preparing' | 'start' }>): string | null {
  return resultText(block) || null
}

/** Narrow opaque persisted `meta` to the export facts the action button needs. */
function graphViewOf(meta: unknown): GraphViewTarget | null {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null
  const { kind, format, path } = meta as Record<string, unknown>
  if (kind !== 'export' || (format !== 'html' && format !== 'svg')) return null
  if (typeof path !== 'string' || path === '') return null
  return { format, path }
}

/** Derive display state and the export action target from the durable slice alone. */
function codeGraphRowModel(block: ToolCallViewProps['block'], callId: string): CodeGraphRowModel {
  const settled = 'kind' in block
  const argsRaw = (settled ? block.call?.argsRaw : block.phase === 'start' ? block.argsRaw : '') ?? ''
  const state: CodeGraphRowState = !settled
    ? 'running'
    : block.error?.code === 'interrupted'
      ? 'stopped'
      : block.isError ? 'error' : 'ok'
  const output = settled ? settledResultText(block) : null
  return {
    state,
    subject: subjectOf(argsRaw, callId),
    output,
    errorSummary: state === 'error' && output !== null ? firstLine(output) : null,
    view: settled && !block.isError ? graphViewOf(block.meta) : null,
  }
}

/**
 * Render one `code_graph` tool call as an accent summary row; a settled export
 * adds the action that opens the viewable graph artifact.
 * @param props - keyed toolview payload, the locale seat, and the artifact opener.
 * @returns the dedicated code-graph row.
 */
export function CodeGraphRow(props: CodeGraphRowProps) {
  if (props.phase === 'preparing') {
    return <div data-tool="code_graph" data-state="preparing" aria-label={props.t('row.preparing')}>
      <DisclosureRow title={props.t('row.title')} icon={<IconBranchOutlineRegular size={14} />}
        open={false} expandable={false} onToggle={noop} running />
    </div>
  }
  return <StartedCodeGraphRow {...props} />
}

/**
 * Bind the session-addressed artifact opener into the row component a slot entry registers. The
 * opener factory lives with the plugin's ctx; the returned component reads the session identity
 * from its own runtime props, so no ctx crosses into the row.
 * @param openForSession - resolves and opens one artifact, addressed by the Session identity.
 * @returns the toolview component closing over that opener.
 */
export function bindCodeGraphRow(openForSession: (sessionId: SessionId, path: string, format: 'html' | 'svg') => Promise<void>) {
  function BoundCodeGraphRow(props: BoundCodeGraphRowProps) {
    return <CodeGraphRow {...props} openView={(path, format) => openForSession(props.sessionId, path, format)} />
  }
  return BoundCodeGraphRow
}

/* v8 ignore next -- Non-expandable rows never invoke DisclosureRow's required toggle callback. */
const noop = (): void => undefined

function StartedCodeGraphRow({
  block, callId, inspect, t, openView,
}: Exclude<CodeGraphRowProps, { phase: 'preparing' }>) {
  const model = codeGraphRowModel(block, callId)
  const [expanded, setExpanded] = useState(false)
  const [opening, setOpening] = useState(false)
  const [failed, setFailed] = useState(false)
  const expandable = model.output !== null
  const summary = model.state === 'stopped' ? t('row.stopped') : model.errorSummary ?? model.subject
  const openTheView = (): void => {
    if (model.view === null || opening) return
    setOpening(true)
    setFailed(false)
    openView(model.view.path, model.view.format)
      .then(() => { setOpening(false) })
      .catch(() => {
        setOpening(false)
        setFailed(true)
      })
  }
  return <div data-tool="code_graph" data-state={model.state}>
    <DisclosureRow title={t('row.title')}
      icon={<IconBranchOutlineRegular size={14} />}
      open={expanded && expandable} expandable={expandable} expandOnRowClick keepContentWhenOpen
      onToggle={() => { setExpanded(value => !value) }}
      collapsedContent={<span className={css.summary}><span>{summary}</span></span>}>
      {model.output !== null ? <pre className={css.output}>{model.output}</pre> : null}
      {model.view !== null ? (
        <button type="button" className={css.view} onClick={openTheView} disabled={opening}>
          {opening ? t('row.viewBusy') : failed ? t('row.viewFailed') : t('row.view')}
        </button>
      ) : null}
      {inspect !== undefined ? (
        <button type="button" className={css.inspect} onClick={inspect}>{t('row.inspect')}</button>
      ) : null}
    </DisclosureRow>
  </div>
}
