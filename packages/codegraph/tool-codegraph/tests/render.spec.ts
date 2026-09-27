import { describe, expect, it } from 'vitest'
import {
  budgetForChars,
  codeGraphMetaFromValue,
  formatReport,
  parseCodeGraphArgs,
  presentCodeGraphCall,
} from '@deepseek-ai/dsh-tool-codegraph'

describe('parseCodeGraphArgs', () => {
  it('accepts the subject-free operations alone', () => {
    expect(parseCodeGraphArgs({ operation: 'repoMap' })).toEqual({ operation: 'repoMap' })
    expect(parseCodeGraphArgs({ operation: 'stats' })).toEqual({ operation: 'stats' })
  })

  it('keeps query subjects and refinements', () => {
    expect(parseCodeGraphArgs({ operation: 'query', question: ' auth ', depth: 2, directed: true }))
      .toEqual({ operation: 'query', question: ' auth ', depth: 2, directed: true })
  })

  it('keeps path endpoints and the directed flag', () => {
    expect(parseCodeGraphArgs({ operation: 'path', source: 'a', target: 'b', directed: false }))
      .toEqual({ operation: 'path', source: 'a', target: 'b', directed: false })
  })

  it('keeps an affected node with depth', () => {
    expect(parseCodeGraphArgs({ operation: 'affected', node: 'X', depth: 5 }))
      .toEqual({ operation: 'affected', node: 'X', depth: 5 })
  })

  it('drops fields the operation does not use', () => {
    expect(parseCodeGraphArgs({ operation: 'explain', node: 'X', question: 'ignored', directed: true }))
      .toEqual({ operation: 'explain', node: 'X' })
  })

  it('rejects an unknown operation', () => {
    expect(() => parseCodeGraphArgs({ operation: 'neighbors' })).toThrow(/operation must be one of/)
  })

  it('rejects a blank subject', () => {
    expect(() => parseCodeGraphArgs({ operation: 'query', question: '  ' })).toThrow(/question/)
    expect(() => parseCodeGraphArgs({ operation: 'explain', node: '' })).toThrow(/node/)
    expect(() => parseCodeGraphArgs({ operation: 'path', source: 'a' })).toThrow(/target/)
  })

  it('rejects a non-positive or fractional depth', () => {
    expect(() => parseCodeGraphArgs({ operation: 'query', question: 'q', depth: 0 })).toThrow(/depth/)
    expect(() => parseCodeGraphArgs({ operation: 'affected', node: 'X', depth: 1.5 })).toThrow(/depth/)
  })

  it('defaults the export format to html and keeps svg', () => {
    expect(parseCodeGraphArgs({ operation: 'export' })).toEqual({ operation: 'export', format: 'html' })
    expect(parseCodeGraphArgs({ operation: 'export', format: 'svg' })).toEqual({ operation: 'export', format: 'svg' })
  })

  it('rejects an unknown export format', () => {
    expect(() => parseCodeGraphArgs({ operation: 'export', format: 'png' })).toThrow(/format/)
  })
})

describe('codeGraphMetaFromValue', () => {
  it('projects the export artifact path', () => {
    expect(codeGraphMetaFromValue({ kind: 'export', format: 'svg', path: '.astria/graph-view.svg', text: 'Exported SVG', truncated: false }))
      .toEqual({ kind: 'export', format: 'svg', path: '.astria/graph-view.svg' })
  })

  it('projects null for the arms without card facts', () => {
    expect(codeGraphMetaFromValue({ kind: 'text', text: 'report', truncated: false })).toBeNull()
    expect(codeGraphMetaFromValue({ kind: 'background', jobId: 'codegraph-1' })).toBeNull()
  })
})

describe('formatReport', () => {
  it('renders a distinct line for an empty report', () => {
    expect(formatReport('', false, 100)).toBe('No output.')
    expect(formatReport('   \n  ', false, 100)).toBe('No output.')
  })

  it('passes a short report through unchanged', () => {
    expect(formatReport('# Map', false, 100)).toBe('# Map')
  })

  it('appends the provider-truncation marker before the cap applies', () => {
    const text = formatReport('abc', true, 100)
    expect(text).toBe('abc\n… output truncated by the provider (tail kept).')
  })

  it('bounds the complete result including the truncation notice', () => {
    const text = formatReport('x'.repeat(100), false, 60)
    expect(text.length).toBe(60)
    expect(text.endsWith('\n… report truncated (limit 60 characters).')).toBe(true)
  })

  it('degrades to the clipped notice when the cap cannot hold text plus notice', () => {
    const text = formatReport('x'.repeat(100), false, 10)
    expect(text.length).toBe(10)
    expect(text.startsWith('\n… report')).toBe(true)
  })
})

describe('budgetForChars', () => {
  it('derives roughly four characters per token', () => {
    expect(budgetForChars(16_000)).toBe(4000)
    expect(budgetForChars(48)).toBe(12)
  })

  it('floors at one token for tiny caps', () => {
    expect(budgetForChars(3)).toBe(1)
  })
})

describe('presentCodeGraphCall', () => {
  it('titles the card with the operation and its subject', () => {
    expect(presentCodeGraphCall({ operation: 'query', question: 'auth' })).toEqual({
      card: 'generic',
      kind: 'search',
      title: 'code_graph query auth',
    })
    expect(presentCodeGraphCall({ operation: 'explain', node: 'Lsp' }).title).toBe('code_graph explain Lsp')
    expect(presentCodeGraphCall({ operation: 'path', source: 'a', target: 'b' }).title).toBe('code_graph path a -> b')
  })

  it('falls back to the operation for subject-free calls', () => {
    expect(presentCodeGraphCall({ operation: 'stats' }).title).toBe('code_graph stats stats')
  })

  it('titles an export call with its format', () => {
    expect(presentCodeGraphCall({ operation: 'export', format: 'svg' }).title).toBe('code_graph export svg')
  })
})
