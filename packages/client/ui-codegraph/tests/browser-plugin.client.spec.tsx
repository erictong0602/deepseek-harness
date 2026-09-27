// @vitest-environment jsdom

import type { JSX as ReactJSX } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { apply, inject } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'

type ComponentProps = Record<string, unknown>

interface PresentationCapture {
  slots: SlotRegistry
  dictionaries: Array<{ namespace: string; dictionaries: unknown }>
}

/** Provide the presentation registries and capture the plugin's registrations. */
function providePresentation(ctx: Context): PresentationCapture {
  const slots = new SlotRegistry(ctx)
  slots.register({
    name: 'root',
    children: { 'tool.call.toolview': { kind: 'keyed', scope: 'session' } },
  } as never, () => null)
  const capture: PresentationCapture = { slots, dictionaries: [] }
  ctx.provide('locale', {
    register(namespace: string, dictionaries: unknown) {
      capture.dictionaries.push({ namespace, dictionaries })
      return () => undefined
    },
    bind: () => (key: string) => key,
  })
  return capture
}

const exportMeta = { kind: 'export', format: 'html', path: '.astria/graph-view.html' }

function settledExport(): ToolResultNode {
  return {
    kind: 'tool-result',
    seq: 3,
    time: 3_000,
    callId: 'call-graph',
    call: { name: 'code_graph', argsRaw: '{"operation":"export"}' },
    callTime: 2_000,
    content: [{ type: 'text', text: 'Exported HTML to: .astria/graph-view.html\ngraph view artifact: .astria/graph-view.html' }],
    isError: false,
    subCalls: [],
    meta: exportMeta,
  }
}

/** The full session-scoped runtime props the registered component receives. */
function runtimeProps(block: ToolResultNode, sessionId: string): ComponentProps {
  return {
    phase: 'result',
    block,
    callId: block.callId,
    toolName: 'code_graph',
    sessionId,
    useDisclosure: () => ({ expanded: false, setExpanded: vi.fn(), toggle: vi.fn() }),
    loadImage: vi.fn(),
    openFile: vi.fn(),
    t: makeTranslate(zh, commonZh),
  }
}

afterEach(cleanup)

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.workspaceFiles'])
  })

  it('registers the keyed code_graph toolview and its locale dictionaries', async () => {
    const ctx = new Context()
    new TestRemote(ctx, { workspaceFiles: { readBytes: vi.fn() } })
    const presentation = providePresentation(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = presentation.slots.entries('tool.call.toolview')[0]
    expect(entry?.options).toMatchObject({ key: 'code_graph' })
    expect(entry?.locale).toBe('codegraph')
    expect(presentation.dictionaries[0]?.namespace).toBe('codegraph')
    expect(presentation.dictionaries[0]).toMatchObject({ dictionaries: { zh } })
    await fiber.dispose()
  })

  it('opens the settled export artifact through the session-authorized remote', async () => {
    const readBytes = vi.fn().mockResolvedValue({
      ok: true,
      value: { path: '.astria/graph-view.html', data: new Uint8Array([60, 104, 116, 109, 108, 62]), offset: 0, eof: true },
    })
    const opened: string[] = []
    const revokeObjectURL = vi.fn()
    const createObjectURL = vi.fn((blob: Blob) => `blob:${blob.type}`)
    // jsdom ships no blob-URL support; patch the two statics and window.open for this test only.
    const hadCreate = 'createObjectURL' in URL
    const hadRevoke = 'revokeObjectURL' in URL
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
    const openSpy = vi.spyOn(window, 'open').mockImplementation(((url: string) => {
      opened.push(url)
      return null
    }) as typeof window.open)
    try {
      const ctx = new Context()
      new TestRemote(ctx, { workspaceFiles: { readBytes } })
      const presentation = providePresentation(ctx)
      const fiber = ctx.plugin({ inject: [...inject], apply })
      await fiber.await()
      const entry = presentation.slots.entries('tool.call.toolview')[0]
      const View = entry?.component as (props: Record<string, unknown>) => ReactJSX.Element
      render(<View {...runtimeProps(settledExport(), 'session-1')} />)
      fireEvent.click(screen.getByRole('button', { name: '代码图export' }))
      fireEvent.click(screen.getByRole('button', { name: '查看图' }))
      await waitFor(() => { expect(opened).toEqual(['blob:text/html']) })
      expect(readBytes).toHaveBeenCalledWith('session-1', '.astria/graph-view.html', {}, expect.any(AbortSignal))
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      await fiber.dispose()
    } finally {
      openSpy.mockRestore()
      if (!hadCreate) Reflect.deleteProperty(URL, 'createObjectURL')
      if (!hadRevoke) Reflect.deleteProperty(URL, 'revokeObjectURL')
    }
  })
})
