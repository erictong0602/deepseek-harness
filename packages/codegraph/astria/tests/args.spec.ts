import { describe, expect, it } from 'vitest'
import type { CodeGraphQueryRequest } from '@deepseek-ai/dsh-codegraph'
import { buildAstriaArgs, buildAstriaRefreshArgs } from '@deepseek-ai/dsh-astria'

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

  it('continues a truncated query from its cursor token', () => {
    expect(buildAstriaArgs(request({ operation: 'query', question: 'wide', cursor: 7 })))
      .toEqual(['query', 'wide', '--graph', '/ws', '--cursor', '7'])
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

  it('maps export with its format and destination, verbatim from the seam', () => {
    expect(buildAstriaArgs(request({ operation: 'export', format: 'html', out: '/ws/.astria/graph-view.html' })))
      .toEqual(['export', '--format', 'html', '--out', '/ws/.astria/graph-view.html', '--graph', '/ws'])
    expect(buildAstriaArgs(request({ operation: 'export', format: 'svg', out: '/ws/.astria/graph-view.svg' })))
      .toEqual(['export', '--format', 'svg', '--out', '/ws/.astria/graph-view.svg', '--graph', '/ws'])
    expect(buildAstriaArgs(request({ operation: 'export', format: 'svg', out: 'graph.svg' })))
      .toEqual(['export', '--format', 'svg', '--out', 'graph.svg', '--graph', '/ws'])
  })

  it('maps hubs onto the god-nodes parity command', () => {
    expect(buildAstriaArgs(request({ operation: 'hubs' })))
      .toEqual(['god-nodes', '--graph', '/ws'])
  })

  it('maps communities onto the parity command of the same name', () => {
    expect(buildAstriaArgs(request({ operation: 'communities' })))
      .toEqual(['communities', '--graph', '/ws'])
  })

  it('maps status onto its machine-readable envelope', () => {
    expect(buildAstriaArgs(request({ operation: 'status' })))
      .toEqual(['status', '--json', '--graph', '/ws'])
  })
})

describe('buildAstriaRefreshArgs', () => {
  it('runs the build pipeline over the workspace path with plain extraction', () => {
    expect(buildAstriaRefreshArgs({ root: '/ws', mode: 'build' })).toEqual(['run', '/ws'])
    expect(buildAstriaRefreshArgs({ root: '/ws', mode: 'build' }, {})).toEqual(['run', '/ws'])
  })

  it('appends the resolved semantic flags for an engine with the jev judge', () => {
    expect(buildAstriaRefreshArgs({ root: '/ws', mode: 'update' }, {
      backend: 'openai',
      model: 'gpt-4o-mini',
      judge: true,
      embed: true,
      labelCommunities: true,
      deep: true,
    })).toEqual([
      'update', '/ws',
      '--backend', 'openai',
      '--judge', 'jev',
      '--model', 'gpt-4o-mini',
      '--embed',
      '--label-communities',
      '--deep',
    ])
  })

  it('keeps the local embedding pass flaggable without a backend', () => {
    expect(buildAstriaRefreshArgs({ root: '/ws', mode: 'update' }, { embed: true }))
      .toEqual(['update', '/ws', '--embed'])
  })
})
