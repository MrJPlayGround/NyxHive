export type AgentMemoryCategory = {
  type: string
  label: string
  count: number
  icon?: string
  source: 'graph' | 'saved' | 'knowledge' | 'context' | 'procedural'
}

export type AgentMemoryOverview = {
  categories: Array<AgentMemoryCategory>
  recentMemories: Array<Record<string, unknown>>
  totals: {
    graphNodes: number
    graphEdges: number
    knowledgeChunks: number
    compiledPages: number
    contextArtifacts: number
    proceduralSkills: number
  }
  briefing: string
  artifactStats: Record<string, unknown>
  knowledgeStats: Record<string, unknown>
  digests: Array<Record<string, unknown>>
  proceduralSkills: Array<Record<string, unknown>>
  warnings: Array<string>
  fetchedAt: number
}

type MemoryBankCategory = {
  type?: unknown
  label?: unknown
  count?: unknown
  icon?: unknown
}

type MemoryBankResponse = {
  categories?: Array<MemoryBankCategory>
  recentMemories?: Array<Record<string, unknown>>
  totalNodes?: unknown
  totalEdges?: unknown
  totalChunks?: unknown
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
      )
    : []
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function pushVirtualCategory(
  categories: Array<AgentMemoryCategory>,
  category: AgentMemoryCategory,
) {
  if (category.count <= 0) return
  if (categories.some((entry) => entry.type === category.type)) return
  categories.push(category)
}

export function buildAgentMemoryOverview(input: {
  bank?: MemoryBankResponse | null
  briefing?: unknown
  artifactStats?: unknown
  knowledgeStats?: unknown
  digests?: unknown
  proceduralSkills?: unknown
  warnings?: Array<string>
  fetchedAt?: number
}): AgentMemoryOverview {
  const bank = input.bank ?? {}
  const artifactStats = asRecord(input.artifactStats)
  const knowledgeStats = asRecord(input.knowledgeStats)
  const digests = asRecordArray(asRecord(input.digests).pages)
  const proceduralSkills = asRecordArray(asRecord(input.proceduralSkills).drafts)
  const proceduralTotal =
    readNumber(asRecord(input.proceduralSkills).total) ||
    proceduralSkills.length
  const artifactTotal = readNumber(artifactStats.total)
  const compiledPages = readNumber(knowledgeStats.compiledPages)

  const categories = (bank.categories ?? [])
    .map((category): AgentMemoryCategory | null => {
      const type = readString(category.type)
      if (!type) return null
      const source =
        type === 'saved'
          ? 'saved'
          : type === 'knowledge'
            ? 'knowledge'
            : 'graph'
      return {
        type,
        label: readString(category.label) || type,
        count: readNumber(category.count),
        icon: readString(category.icon) || undefined,
        source,
      }
    })
    .filter((category): category is AgentMemoryCategory => Boolean(category))

  pushVirtualCategory(categories, {
    type: 'context_artifacts',
    label: 'Context Artifacts',
    count: artifactTotal,
    icon: 'archive',
    source: 'context',
  })
  pushVirtualCategory(categories, {
    type: 'knowledge_digests',
    label: 'Compiled Digests',
    count: compiledPages || digests.length,
    icon: 'notebook',
    source: 'knowledge',
  })
  pushVirtualCategory(categories, {
    type: 'procedural_skills',
    label: 'Procedural Skills',
    count: proceduralTotal,
    icon: 'workflow',
    source: 'procedural',
  })

  return {
    categories,
    recentMemories: asRecordArray(bank.recentMemories),
    totals: {
      graphNodes: readNumber(bank.totalNodes),
      graphEdges: readNumber(bank.totalEdges),
      knowledgeChunks: readNumber(bank.totalChunks),
      compiledPages,
      contextArtifacts: artifactTotal,
      proceduralSkills: proceduralTotal,
    },
    briefing: readString(asRecord(input.briefing).briefing),
    artifactStats,
    knowledgeStats,
    digests,
    proceduralSkills,
    warnings: input.warnings ?? [],
    fetchedAt: input.fetchedAt ?? Date.now(),
  }
}

export function normalizeAgentMemoryBucket(
  type: string,
  payload: unknown,
): {
  type: string
  items: Array<Record<string, unknown>>
  total: number
} {
  const record = asRecord(payload)
  const items =
    asRecordArray(record.items).length > 0
      ? asRecordArray(record.items)
      : asRecordArray(record.artifacts).length > 0
        ? asRecordArray(record.artifacts)
        : asRecordArray(record.pages).length > 0
          ? asRecordArray(record.pages)
          : asRecordArray(record.drafts)

  return {
    type,
    items,
    total: readNumber(record.total) || readNumber(record.count) || items.length,
  }
}
