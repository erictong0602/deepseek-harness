/**
 * Pure normalization of `astria status --json` output: parses the CLI's machine-readable freshness
 * envelope (astria ≥ 1.0.6) and renders it as a compact, provider-stable report so consumers see
 * the same facts whatever the CLI's prose formatting becomes. No I/O — the provider hands over the
 * collected stdout verbatim.
 * @module @deepseek-ai/dsh-astria/status
 */

/** The freshness facts the astria ≥ 1.0.6 `status --json` envelope carries. */
export interface AstriaStatusFacts {
  /** `fresh`/`stale`/`very_stale` for a complete graph, or `missing`/`empty`/`incomplete`. */
  readonly status: string
  readonly ageMinutes?: number
  readonly nodes?: number
  readonly edges?: number
  readonly communities?: number
  readonly files?: number
  /** Finished-at timestamp (unix seconds) of the most recent completed pipeline run. */
  readonly builtAt?: string | null
  /** npm CLI version that built the graph; null for graphs built before version stamping. */
  readonly astriaVersion?: string | null
  /** Extraction-rules version the graph was produced by; null before stamping. */
  readonly extractionHashVersion?: string | null
  /** Extraction-rules version compiled into the queried binary. */
  readonly currentExtractionHashVersion?: string | null
  /** True when the graph predates the binary's extraction rules — re-extraction is due. */
  readonly extractionOutdated?: boolean
}

/**
 * Parse the `astria status --json` envelope. Returns `undefined` for anything that is not the JSON
 * object shape (an older CLI without `--json` fails at spawn, so this only guards a future CLI
 * changing its output); the caller then passes the raw text through unchanged.
 * @param stdout - the collected stdout of one `status --json` run.
 * @returns the freshness facts, or `undefined` when the output is not the envelope.
 */
export function parseAstriaStatus(stdout: string): AstriaStatusFacts | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.status !== 'string') return undefined
  return {
    status: record.status,
    ...typeof record.ageMinutes === 'number' ? { ageMinutes: record.ageMinutes } : {},
    ...typeof record.nodes === 'number' ? { nodes: record.nodes } : {},
    ...typeof record.edges === 'number' ? { edges: record.edges } : {},
    ...typeof record.communities === 'number' ? { communities: record.communities } : {},
    ...typeof record.files === 'number' ? { files: record.files } : {},
    ...typeof record.builtAt === 'string' || record.builtAt === null ? { builtAt: record.builtAt } : {},
    ...typeof record.astriaVersion === 'string' || record.astriaVersion === null
      ? { astriaVersion: record.astriaVersion }
      : {},
    ...typeof record.extractionHashVersion === 'string' || record.extractionHashVersion === null
      ? { extractionHashVersion: record.extractionHashVersion }
      : {},
    ...typeof record.currentExtractionHashVersion === 'string' || record.currentExtractionHashVersion === null
      ? { currentExtractionHashVersion: record.currentExtractionHashVersion }
      : {},
    ...typeof record.extractionOutdated === 'boolean' ? { extractionOutdated: record.extractionOutdated } : {},
  }
}

/**
 * Render the freshness facts as the provider's status report: staleness first, then counts, then
 * build facts and the re-extraction warning the freshness probe exists to surface.
 * @param facts - the parsed envelope.
 * @returns the normalized multi-line report.
 */
export function renderAstriaStatus(facts: AstriaStatusFacts): string {
  const lines: string[] = [`Status: ${facts.status}`]
  if (facts.ageMinutes !== undefined) lines.push(`Age: ${facts.ageMinutes} min`)
  const counts = [
    facts.nodes !== undefined ? `nodes ${facts.nodes}` : undefined,
    facts.edges !== undefined ? `edges ${facts.edges}` : undefined,
    facts.communities !== undefined ? `communities ${facts.communities}` : undefined,
    facts.files !== undefined ? `files ${facts.files}` : undefined,
  ].filter((part): part is string => part !== undefined)
  if (counts.length > 0) lines.push(`Counts: ${counts.join(', ')}`)
  const builtBy = facts.astriaVersion !== undefined && facts.astriaVersion !== null
    ? ` by astria ${facts.astriaVersion}`
    : ''
  const builtAt = facts.builtAt !== undefined && facts.builtAt !== null ? ` at unix ${facts.builtAt}` : ''
  if (builtBy !== '' || builtAt !== '') lines.push(`Built:${builtAt}${builtBy}`)
  if (facts.extractionHashVersion !== undefined && facts.extractionHashVersion !== null) {
    lines.push(`Extraction rules: ${facts.extractionHashVersion}`)
  }
  if (facts.extractionOutdated === true) {
    lines.push('Warning: the graph predates this astria\'s extraction rules; run an update to re-extract.')
  }
  return lines.join('\n')
}
