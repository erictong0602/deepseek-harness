import { describe, expect, it } from 'vitest'
import type { CodeGraphQueryRequest } from '@deepseek-ai/dsh-codegraph'
import { buildAstriaArgs } from '@deepseek-ai/dsh-astria'

/** A request against one fixed root, varying only the query. */
function request(query: CodeGraphQueryRequest['query']): CodeGraphQueryRequest {
  return { root: '/ws', query }
}

describe('buildAstriaArgs', () => {
  it('maps repoMap with the graph root and no budget by default', () => {
    expect(buildAstriaArgs(request({ operation: 'repoMap' })))
      .toEqual(['map', '--graph', '/ws'])
  })

  it('appends the token budget when set', () => {
    expect(buildAstriaArgs(request({ operation: 'repoMap', budgetTokens: 4000 })))
      .toEqual(['map', '--graph', '/ws', '--budget', '4000'])
  })

  it('maps query with its subject and every refinement flag', () => {
    expect(buildAstriaArgs(request({ operation: 'query', question: 'how does auth work', depth: 3, directed: true, budgetTokens: 2000 })))
      .toEqual(['query', 'how does auth work', '--graph', '/ws', '--depth', '3', '--directed', '--budget', '2000'])
  })

  it('omits unset query refinements', () => {
    expect(buildAstriaArgs(request({ operation: 'query', question: 'entry points' })))
      .toEqual(['query', 'entry points', '--graph', '/ws'])
  })

  it('maps explain with the node subject', () => {
    expect(buildAstriaArgs(request({ operation: 'explain', node: 'Lsp' })))
      .toEqual(['explain', 'Lsp', '--graph', '/ws'])
  })

  it('maps path with both endpoints and the directed flag', () => {
    expect(buildAstriaArgs(request({ operation: 'path', source: 'A', target: 'B', directed: true })))
      .toEqual(['path', 'A', 'B', '--graph', '/ws', '--directed'])
    expect(buildAstriaArgs(request({ operation: 'path', source: 'A', target: 'B' })))
      .toEqual(['path', 'A', 'B', '--graph', '/ws'])
  })

  it('maps affected with depth when set', () => {
    expect(buildAstriaArgs(request({ operation: 'affected', node: 'finalExtension', depth: 4 })))
      .toEqual(['affected', 'finalExtension', '--graph', '/ws', '--depth', '4'])
    expect(buildAstriaArgs(request({ operation: 'affected', node: 'finalExtension' })))
      .toEqual(['affected', 'finalExtension', '--graph', '/ws'])
  })

  it('maps stats with only the graph root', () => {
    expect(buildAstriaArgs(request({ operation: 'stats' })))
      .toEqual(['stats', '--graph', '/ws'])
  })
})
