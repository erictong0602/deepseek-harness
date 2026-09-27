// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StartedToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ToolCallOwnerProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { CodeGraphRow } from '../src/client/CodeGraphRow.tsx'
import { zh } from '../src/client/locales.ts'

type CodeGraphRowProps = Parameters<typeof CodeGraphRow>[0]

const t: CodeGraphRowProps['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

function settled(over: Partial<ToolResultNode> = {}): ToolResultNode {
  return {
    kind: 'tool-result',
    seq: 3,
    time: 3_000,
    callId: 'call-graph',
    call: { name: 'code_graph', argsRaw: '{"operation":"stats"}' },
    callTime: 2_000,
    content: [{ type: 'text', text: '10 nodes, 9 edges' }],
    isError: false,
    subCalls: [],
    ...over,
  }
}

function running(argsRaw = '{"operation":"query","question":"auth"}'): StartedToolCall {
  return {
    phase: 'start' as const, callId: 'call-graph', name: 'code_graph', argsRaw, turn: 1, step: 1, time: 2_000, subCalls: [],
  }
}

function props(
  block: CodeGraphRowProps['block'],
  openView: CodeGraphRowProps['openView'] = vi.fn(),
  inspect?: () => void,
): CodeGraphRowProps {
  const owner: ToolCallOwnerProps = {
    callId: block.callId,
    toolName: 'code_graph',
    ...('kind' in block ? { phase: 'result' as const, block }
      : block.phase === 'preparing' ? { phase: 'preparing' as const, block } : { phase: 'start' as const, block }),
    useDisclosure: () => ({ expanded: false, setExpanded: vi.fn(), toggle: vi.fn() }),
    loadImage: vi.fn<ToolCallOwnerProps['loadImage']>(),
    openFile: vi.fn(),
    inspect,
  }
  return { ...owner, t, openView } as CodeGraphRowProps
}

describe('CodeGraphRow', () => {
  it('shows preparation without subject or disclosure', () => {
    const view = render(<CodeGraphRow {...props({
      phase: 'preparing', callId: 'call-graph', name: 'code_graph', turn: 1, step: 1, time: 1, subCalls: [],
    })} />)
    expect(view.getByLabelText('准备查询代码图')).toBeTruthy()
    expect(view.container.querySelector('pre')).toBeNull()
  })

  it('renders the operation subject while running, without an output disclosure', () => {
    const view = render(<CodeGraphRow {...props(running())} />)
    expect(view.container.querySelector('[data-tool="code_graph"]')?.getAttribute('data-state')).toBe('running')
    expect(view.container.textContent).toContain('query auth')
    expect(view.container.querySelector('pre')).toBeNull()
    expect(screen.queryByRole('button', { name: '查看图' })).toBeNull()
  })

  it('discloses the settled report and names the export artifact action', () => {
    const openView = vi.fn().mockResolvedValue(undefined)
    const view = render(<CodeGraphRow {...props(settled({
      call: { name: 'code_graph', argsRaw: '{"operation":"export","format":"svg"}' },
      content: [{ type: 'text', text: 'Exported SVG to: .astria/graph-view.svg (10 nodes)' }],
      meta: { kind: 'export', format: 'svg', path: '.astria/graph-view.svg' },
    }), openView)} />)
    const row = screen.getByRole('button', { name: /代码图/ })
    expect(view.container.querySelector('[data-tool="code_graph"]')?.getAttribute('data-state')).toBe('ok')
    expect(view.container.textContent).toContain('export svg')

    fireEvent.click(row)
    expect(screen.getByText('Exported SVG to: .astria/graph-view.svg (10 nodes)')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看图' }))
    expect(openView).toHaveBeenCalledWith('.astria/graph-view.svg', 'svg')
  })

  it('surfaces an open failure as the action copy', async () => {
    const openView = vi.fn().mockRejectedValue(new Error('gone'))
    render(<CodeGraphRow {...props(settled({
      meta: { kind: 'export', format: 'html', path: '.astria/graph-view.html' },
    }), openView)} />)
    const row = screen.getByRole('button', { name: /代码图/ })
    fireEvent.click(row)
    fireEvent.click(screen.getByRole('button', { name: '查看图' }))
    await screen.findByText('打开图失败')
  })

  it('offers no action without export meta, on failures, or for malformed meta', () => {
    const cases: ToolResultNode[] = [
      settled(),
      settled({
        isError: true,
        error: { name: 'CodeGraphError', code: 'CODEGRAPH_EXIT' },
        content: [],
        meta: { kind: 'export', format: 'html', path: '.astria/graph-view.html' },
      }),
      settled({ meta: { kind: 'export', format: 'png', path: '' } }),
    ]
    for (const block of cases) {
      const view = render(<CodeGraphRow {...props(block)} />)
      fireEvent.click(screen.getByRole('button', { name: /代码图/ }))
      expect(screen.queryByRole('button', { name: '查看图' })).toBeNull()
      view.unmount()
    }
  })

  it('summarizes an error result from its first result line', () => {
    const view = render(<CodeGraphRow {...props(settled({
      isError: true,
      error: { name: 'CodeGraphError', code: 'CODEGRAPH_EXIT' },
      content: [{ type: 'text', text: 'astria stats failed with exit code 1: boom' }],
    }))} />)
    expect(view.container.querySelector('[data-tool="code_graph"]')?.getAttribute('data-state')).toBe('error')
    expect(view.container.textContent).toContain('astria stats failed with exit code 1: boom')
  })
})
