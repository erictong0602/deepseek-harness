import { describe, expect, it } from 'vitest'
import { parseAstriaStatus, renderAstriaStatus } from '@deepseek-ai/dsh-astria'

describe('parseAstriaStatus', () => {
  it('parses the complete astria 1.0.6 envelope', () => {
    const stdout = JSON.stringify({
      status: 'fresh',
      ageMinutes: 3,
      nodes: 120,
      edges: 340,
      communities: 9,
      files: 40,
      builtAt: '1790520977',
      astriaVersion: '1.0.6',
      extractionHashVersion: 'v10',
      currentExtractionHashVersion: 'v10',
      extractionOutdated: false,
    })
    expect(parseAstriaStatus(stdout)).toEqual({
      status: 'fresh',
      ageMinutes: 3,
      nodes: 120,
      edges: 340,
      communities: 9,
      files: 40,
      builtAt: '1790520977',
      astriaVersion: '1.0.6',
      extractionHashVersion: 'v10',
      currentExtractionHashVersion: 'v10',
      extractionOutdated: false,
    })
  })

  it('keeps explicit nulls and omits absent fields', () => {
    const facts = parseAstriaStatus(JSON.stringify({ status: 'stale', astriaVersion: null, builtAt: null }))
    expect(facts).toEqual({ status: 'stale', astriaVersion: null, builtAt: null })
  })

  it('rejects non-JSON text', () => {
    expect(parseAstriaStatus('Status: fresh (3 min ago)')).toBeUndefined()
  })

  it('rejects JSON without a string status', () => {
    expect(parseAstriaStatus('{"nodes": 5}')).toBeUndefined()
    expect(parseAstriaStatus('[1, 2]')).toBeUndefined()
    expect(parseAstriaStatus('null')).toBeUndefined()
  })
})

describe('renderAstriaStatus', () => {
  it('renders staleness, counts, provenance, and the extraction warning in order', () => {
    const text = renderAstriaStatus({
      status: 'stale',
      ageMinutes: 45,
      nodes: 120,
      edges: 340,
      communities: 9,
      files: 40,
      builtAt: '1790520977',
      astriaVersion: '1.0.5',
      extractionHashVersion: 'v9',
      currentExtractionHashVersion: 'v10',
      extractionOutdated: true,
    })
    expect(text).toEqual([
      'Status: stale',
      'Age: 45 min',
      'Counts: nodes 120, edges 340, communities 9, files 40',
      'Built: at unix 1790520977 by astria 1.0.5',
      'Extraction rules: v9',
      'Warning: the graph predates this astria\'s extraction rules; run an update to re-extract.',
    ].join('\n'))
  })

  it('renders a minimal missing report with only the status line', () => {
    expect(renderAstriaStatus({ status: 'missing' })).toBe('Status: missing')
  })

  it('omits the built line when provenance was never stamped', () => {
    const text = renderAstriaStatus({ status: 'empty', nodes: 0, astriaVersion: null, builtAt: null })
    expect(text).toBe('Status: empty\nCounts: nodes 0')
  })
})
