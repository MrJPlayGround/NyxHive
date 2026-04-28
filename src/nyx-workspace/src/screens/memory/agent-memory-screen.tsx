import { HugeiconsIcon } from '@hugeicons/react'
import {
  BrainIcon,
  CodeIcon,
  DatabaseIcon,
  File01Icon,
  Folder01Icon,
  Link01Icon,
  Message01Icon,
  Search01Icon,
} from '@hugeicons/core-free-icons'
import { useQuery } from '@tanstack/react-query'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'

type AgentMemoryCategory = {
  type: string
  label: string
  count: number
  icon?: string
  source: 'graph' | 'saved' | 'knowledge' | 'context' | 'procedural'
}

type AgentMemoryOverview = {
  categories?: Array<AgentMemoryCategory>
  recentMemories?: Array<Record<string, unknown>>
  totals?: {
    graphNodes?: number
    graphEdges?: number
    knowledgeChunks?: number
    compiledPages?: number
    contextArtifacts?: number
    proceduralSkills?: number
  }
  briefing?: string
  artifactStats?: Record<string, unknown>
  knowledgeStats?: Record<string, unknown>
  digests?: Array<Record<string, unknown>>
  proceduralSkills?: Array<Record<string, unknown>>
  warnings?: Array<string>
  fetchedAt?: number
}

type AgentMemoryBucket = {
  type?: string
  items?: Array<Record<string, unknown>>
  total?: number
}

const CATEGORY_ORDER = [
  'identity',
  'decision',
  'pattern',
  'goal',
  'preference',
  'fact',
  'error',
  'task',
  'saved',
  'knowledge',
  'knowledge_digests',
  'context_artifacts',
  'procedural_skills',
]

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `Request failed (${response.status})`)
  }
  return (await response.json()) as T
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function formatNumber(value: unknown): string {
  const number = readNumber(value) ?? 0
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(
    number,
  )
}

function formatTimestamp(value: unknown): string | null {
  const numeric = readNumber(value)
  if (!numeric) return null
  const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(millis))
}

function sortCategories(
  categories: Array<AgentMemoryCategory>,
): Array<AgentMemoryCategory> {
  return [...categories].sort((left, right) => {
    const leftIndex = CATEGORY_ORDER.indexOf(left.type)
    const rightIndex = CATEGORY_ORDER.indexOf(right.type)
    const normalizedLeft = leftIndex === -1 ? CATEGORY_ORDER.length : leftIndex
    const normalizedRight =
      rightIndex === -1 ? CATEGORY_ORDER.length : rightIndex
    return (
      normalizedLeft - normalizedRight ||
      right.count - left.count ||
      left.label.localeCompare(right.label)
    )
  })
}

function sourceLabel(source: AgentMemoryCategory['source']): string {
  switch (source) {
    case 'context':
      return 'retrieval'
    case 'procedural':
      return 'learned'
    case 'knowledge':
      return 'knowledge'
    case 'saved':
      return 'saved'
    default:
      return 'graph'
  }
}

function itemTitle(item: Record<string, unknown>, fallback: string): string {
  return (
    readString(item.title) ||
    readString(item.name) ||
    readString(item.source_label) ||
    readString(item.source_path) ||
    readString(item.skill_name) ||
    readString(item.published_skill_name) ||
    fallback
  )
}

function itemBody(item: Record<string, unknown>): string {
  return (
    readString(item.content) ||
    readString(item.summary) ||
    readString(item.l1_overview) ||
    readString(item.l0_abstract) ||
    readString(item.description) ||
    readString(item.body) ||
    readString(item.rationale) ||
    readString(item.extracted_pattern) ||
    ''
  )
}

function itemMeta(item: Record<string, unknown>): Array<string> {
  const entries = [
    readString(item.type),
    readString(item.category),
    readString(item.status),
    readString(item.source_kind),
    readString(item.agent_key),
    formatTimestamp(item.updated_at) || formatTimestamp(item.created_at),
  ].filter(Boolean)
  return Array.from(new Set(entries)).slice(0, 4)
}

function categoryIcon(category: AgentMemoryCategory) {
  if (category.source === 'procedural') return CodeIcon
  if (category.source === 'knowledge') return Folder01Icon
  if (category.source === 'context') return Link01Icon
  if (category.source === 'saved') return File01Icon
  return BrainIcon
}

export function AgentMemoryScreen() {
  const [selectedType, setSelectedType] = useState<string | null>(null)
  const [searchInput, setSearchInput] = useState('')
  const deferredSearch = useDeferredValue(searchInput)
  const searchTerm = deferredSearch.trim()

  const overviewQuery = useQuery({
    queryKey: ['agent-memory', 'overview'],
    queryFn: () => readJson<AgentMemoryOverview>('/api/agent-memory'),
    refetchInterval: 30_000,
  })

  const categories = useMemo(
    () => sortCategories(overviewQuery.data?.categories ?? []),
    [overviewQuery.data?.categories],
  )

  useEffect(() => {
    if (selectedType || categories.length === 0) return
    const preferred =
      categories.find((category) => category.type === 'identity') ??
      categories[0]
    setSelectedType(preferred.type)
  }, [categories, selectedType])

  const selectedCategory = useMemo(
    () => categories.find((category) => category.type === selectedType) ?? null,
    [categories, selectedType],
  )

  const bucketQuery = useQuery({
    queryKey: ['agent-memory', 'bucket', selectedType, searchTerm],
    queryFn: () =>
      readJson<AgentMemoryBucket>(
        `/api/agent-memory?type=${encodeURIComponent(
          selectedType || '',
        )}&limit=80${searchTerm ? `&q=${encodeURIComponent(searchTerm)}` : ''}`,
      ),
    enabled: Boolean(selectedType),
  })

  const items = bucketQuery.data?.items ?? []
  const totals = overviewQuery.data?.totals ?? {}
  const warnings = overviewQuery.data?.warnings ?? []
  const recentMemories = overviewQuery.data?.recentMemories ?? []

  if (overviewQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 text-sm text-neutral-400">
        Loading agent memory...
      </div>
    )
  }

  if (overviewQuery.isError) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-xl rounded-lg border border-red-900/60 bg-red-950/40 p-5 text-sm text-red-100">
          {overviewQuery.error instanceof Error
            ? overviewQuery.error.message
            : 'Agent memory is unavailable.'}
        </div>
      </div>
    )
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 overflow-hidden bg-neutral-950 text-neutral-100 lg:grid-cols-[340px_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-y-auto border-b border-neutral-800 bg-neutral-950 p-4 lg:border-b-0 lg:border-r">
        <div className="mb-4">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">
            Agent Memory
          </p>
          <h2 className="mt-1 text-xl font-semibold text-neutral-100">
            Runtime memory
          </h2>
          <p className="mt-2 text-sm leading-6 text-neutral-400">
            Canonical memory for this workspace. Vault files are source
            material; cross-agent context stays explicit.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <MetricCard label="Graph" value={totals.graphNodes} />
          <MetricCard label="Edges" value={totals.graphEdges} />
          <MetricCard label="Knowledge" value={totals.knowledgeChunks} />
          <MetricCard label="Digests" value={totals.compiledPages} />
        </div>

        <div className="mt-4 space-y-2">
          {categories.map((category) => {
            const Icon = categoryIcon(category)
            return (
              <button
                key={category.type}
                type="button"
                onClick={() => setSelectedType(category.type)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg border px-3 py-3 text-left transition',
                  selectedType === category.type
                    ? 'border-neutral-500 bg-neutral-800 text-neutral-100 shadow-sm'
                    : 'border-neutral-800 bg-neutral-950 text-neutral-300 hover:border-neutral-700 hover:bg-neutral-900',
                )}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-neutral-700 bg-neutral-900 text-neutral-300">
                  <HugeiconsIcon icon={Icon} size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {category.label}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {sourceLabel(category.source)}
                  </span>
                </span>
                <span className="rounded-full bg-neutral-800 px-2 py-1 text-xs font-semibold text-neutral-300">
                  {formatNumber(category.count)}
                </span>
              </button>
            )
          })}
        </div>
      </aside>

      <main className="min-h-0 overflow-y-auto bg-neutral-950 p-4 md:p-6">
        <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/70 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-neutral-100">
              <HugeiconsIcon icon={BrainIcon} size={18} />
              Briefing
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-neutral-300">
              {overviewQuery.data?.briefing?.trim() ||
                'No graph briefing is available yet.'}
            </p>
          </div>

          <div className="rounded-lg border border-neutral-800 bg-neutral-900/70 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-neutral-100">
              <HugeiconsIcon icon={DatabaseIcon} size={18} />
              Health
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <MetricCard label="Artifacts" value={totals.contextArtifacts} />
              <MetricCard label="Skills" value={totals.proceduralSkills} />
            </div>
            {warnings.length > 0 ? (
              <div className="mt-3 rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-xs leading-5 text-amber-100">
            {warnings.slice(0, 2).map((warning) => (
                  <div key={warning}>{warning}</div>
                ))}
              </div>
            ) : null}
          </div>
        </section>

        <section className="mt-5 rounded-lg border border-neutral-800 bg-neutral-950">
          <div className="flex flex-col gap-3 border-b border-neutral-800 p-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">
                {selectedCategory ? sourceLabel(selectedCategory.source) : ''}
              </p>
              <h3 className="mt-1 text-lg font-semibold text-neutral-100">
                {selectedCategory?.label ?? 'Memory bucket'}
              </h3>
            </div>
            <label className="flex min-h-10 w-full items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900 px-3 text-sm text-neutral-300 md:max-w-sm">
              <HugeiconsIcon icon={Search01Icon} size={16} />
              <input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search this bucket"
                className="w-full bg-transparent text-sm outline-none placeholder:text-neutral-600"
              />
            </label>
          </div>

          <div className="divide-y divide-neutral-900">
            {bucketQuery.isFetching ? (
              <div className="p-6 text-sm text-neutral-400">
                Loading records...
              </div>
            ) : items.length > 0 ? (
              items.map((item, index) => (
                <MemoryRecord
                  key={`${selectedType}:${readString(item.id) || index}`}
                  item={item}
                  fallback={`Record ${index + 1}`}
                />
              ))
            ) : (
              <div className="p-6 text-sm text-neutral-400">
                No records in this bucket.
              </div>
            )}
          </div>
        </section>

        <section className="mt-5 grid gap-4 xl:grid-cols-2">
          <RecentPanel title="Recent graph memory" items={recentMemories} />
          <RecentPanel
            title="Compiled knowledge"
            items={overviewQuery.data?.digests ?? []}
          />
        </section>
      </main>
    </div>
  )
}

function MetricCard({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-3">
      <div className="text-lg font-semibold text-neutral-100">
        {formatNumber(value)}
      </div>
      <div className="mt-1 text-xs uppercase tracking-[0.14em] text-neutral-500">
        {label}
      </div>
    </div>
  )
}

function MemoryRecord({
  item,
  fallback,
}: {
  item: Record<string, unknown>
  fallback: string
}) {
  const title = itemTitle(item, fallback)
  const body = itemBody(item)
  const meta = itemMeta(item)
  return (
    <article className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="min-w-0 text-sm font-semibold text-neutral-100">
          {title}
        </h4>
        {meta.map((entry) => (
          <span
            key={entry}
            className="rounded-full bg-neutral-900 px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-400"
          >
            {entry}
          </span>
        ))}
      </div>
      {body ? (
        <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm leading-6 text-neutral-300">
          {body}
        </p>
      ) : null}
    </article>
  )
}

function RecentPanel({
  title,
  items,
}: {
  title: string
  items: Array<Record<string, unknown>>
}) {
  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-950">
      <div className="flex items-center gap-2 border-b border-neutral-800 p-4 text-sm font-semibold text-neutral-100">
        <HugeiconsIcon icon={Message01Icon} size={17} />
        {title}
      </div>
      <div className="divide-y divide-neutral-900">
        {items.slice(0, 6).map((item, index) => (
          <MemoryRecord
            key={`${title}:${readString(item.id) || index}`}
            item={item}
            fallback={`Item ${index + 1}`}
          />
        ))}
        {items.length === 0 ? (
          <div className="p-4 text-sm text-neutral-400">
            Nothing ready yet.
          </div>
        ) : null}
      </div>
    </section>
  )
}
