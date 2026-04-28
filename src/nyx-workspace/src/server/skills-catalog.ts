import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'

export type SkillsSort = 'name' | 'category'

export type SecurityRisk = {
  level: 'safe' | 'low' | 'medium' | 'high'
  flags: Array<string>
  score: number
}

export type SkillSummary = {
  id: string
  slug: string
  name: string
  description: string
  author: string
  triggers: Array<string>
  tags: Array<string>
  homepage: string | null
  category: string
  icon: string
  content: string
  fileCount: number
  sourcePath: string
  installed: boolean
  enabled: boolean
  builtin?: boolean
  featuredGroup?: string
  security: SecurityRisk
}

export const KNOWN_CATEGORIES = [
  'All',
  'NyxHive',
  'Agent Memory',
  'Web & Frontend',
  'Coding Agents',
  'Git & GitHub',
  'DevOps & Cloud',
  'Browser & Automation',
  'Image & Video',
  'Search & Research',
  'AI & LLMs',
  'Productivity',
  'Marketing & Sales',
  'Communication',
  'Data & Analytics',
  'Finance & Crypto',
] as const

export function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

export function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function readStringArray(value: unknown): Array<string> {
  if (!Array.isArray(value)) return []
  return value.map((entry) => readString(entry)).filter(Boolean)
}

export function slugify(input: string): string {
  const result = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
  return result || 'skill'
}

export function normalizeSecurity(value: unknown): SecurityRisk {
  const record = asRecord(value)
  const level = readString(record.level)
  return {
    level:
      level === 'low' ||
      level === 'medium' ||
      level === 'high' ||
      level === 'safe'
        ? level
        : 'safe',
    flags: readStringArray(record.flags),
    score:
      typeof record.score === 'number' && Number.isFinite(record.score)
        ? record.score
        : 0,
  }
}

export function guessCategory(record: Record<string, unknown>): string {
  const direct =
    readString(record.category) ||
    readString(record.group) ||
    readString(record.section)
  if (direct) return direct

  const tags = readStringArray(record.tags).map((tag) => tag.toLowerCase())
  const searchable = [
    readString(record.id),
    readString(record.slug),
    readString(record.name),
    readString(record.description),
    ...tags,
  ]
    .join(' ')
    .toLowerCase()

  if (searchable.includes('procedural') || searchable.includes('memory')) {
    return 'Agent Memory'
  }
  if (
    searchable.includes('codex') ||
    searchable.includes('agent') ||
    searchable.includes('harness')
  ) {
    return 'Coding Agents'
  }
  if (searchable.includes('frontend') || searchable.includes('react')) {
    return 'Web & Frontend'
  }
  if (searchable.includes('browser')) return 'Browser & Automation'
  if (searchable.includes('git')) return 'Git & GitHub'
  if (searchable.includes('ai') || searchable.includes('llm')) return 'AI & LLMs'
  if (searchable.includes('test') || searchable.includes('verify')) {
    return 'NyxHive'
  }
  return 'Productivity'
}

export function normalizeSkill(value: unknown): SkillSummary | null {
  const record = asRecord(value)
  const id =
    readString(record.id) || readString(record.slug) || readString(record.name)
  if (!id) return null

  const name = readString(record.name) || id
  const sourcePath =
    readString(record.sourcePath) ||
    readString(record.path) ||
    readString(record.file) ||
    ''

  return {
    id,
    slug: readString(record.slug) || slugify(id),
    name,
    description: readString(record.description),
    author:
      readString(record.author) ||
      readString(record.owner) ||
      readString(record.publisher),
    triggers: readStringArray(record.triggers),
    tags: readStringArray(record.tags),
    homepage: readString(record.homepage) || null,
    category: guessCategory(record),
    icon: readString(record.icon) || '✨',
    content:
      readString(record.content) ||
      readString(record.readme) ||
      readString(record.prompt),
    fileCount:
      typeof record.fileCount === 'number' && Number.isFinite(record.fileCount)
        ? record.fileCount
        : 0,
    sourcePath,
    installed: Boolean(record.installed ?? true),
    enabled: Boolean(record.enabled ?? record.installed ?? true),
    builtin: Boolean(record.builtin),
    featuredGroup: undefined,
    security: normalizeSecurity(record.security),
  }
}

function parseFrontmatter(markdown: string): Record<string, string> {
  if (!markdown.startsWith('---\n')) return {}

  const end = markdown.indexOf('\n---', 4)
  if (end === -1) return {}

  const frontmatter = markdown.slice(4, end)
  const fields: Record<string, string> = {}
  for (const line of frontmatter.split('\n')) {
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '')
    if (key && value) fields[key] = value
  }
  return fields
}

function findHeading(markdown: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m)
  return heading?.[1]?.trim() || ''
}

function firstParagraph(markdown: string): string {
  const body = markdown.replace(/^---[\s\S]*?\n---\s*/, '').trim()
  const paragraphs = body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph && !paragraph.startsWith('#'))
  return paragraphs[0]?.replace(/\s+/g, ' ') || ''
}

function countFiles(directory: string): number {
  let count = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      count += countFiles(path)
    } else if (entry.isFile()) {
      count += 1
    }
  }
  return count
}

function uniqueStrings(values: Array<string>): Array<string> {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function resolveLocalSkillRoots(cwd: string): Array<string> {
  const candidates = [
    resolve(cwd, 'skills'),
    resolve(cwd, '..', 'skills'),
    resolve(cwd, '..', '..', 'skills'),
  ]
  return [...new Set(candidates)].filter((candidate) => existsSync(candidate))
}

export function readLocalSkills(options?: {
  cwd?: string
  roots?: Array<string>
}): Array<SkillSummary> {
  const roots = options?.roots ?? resolveLocalSkillRoots(options?.cwd ?? process.cwd())
  const skills: Array<SkillSummary> = []

  for (const root of roots) {
    if (!existsSync(root) || !statSync(root).isDirectory()) continue
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const skillPath = join(root, entry.name)
      const skillFile = join(skillPath, 'SKILL.md')
      if (!existsSync(skillFile)) continue

      const content = readFileSync(skillFile, 'utf8')
      const frontmatter = parseFrontmatter(content)
      const name = frontmatter.name || findHeading(content) || entry.name
      const description = frontmatter.description || firstParagraph(content)
      const tags = [
        'local',
        'nyxhive',
        ...entry.name.split('-').filter(Boolean),
      ]

      skills.push({
        id: `local:${entry.name}`,
        slug: entry.name,
        name,
        description,
        author: 'NyxHive',
        triggers: uniqueStrings([entry.name, name]),
        tags,
        homepage: null,
        category: guessCategory({
          id: entry.name,
          name,
          description,
          tags,
        }),
        icon: '⚙️',
        content,
        fileCount: countFiles(skillPath),
        sourcePath: skillFile,
        installed: true,
        enabled: true,
        builtin: true,
        security: {
          level: 'safe',
          flags: [],
          score: 0,
        },
      })
    }
  }

  return skills
}

export function normalizeProceduralSkills(payload: unknown): Array<SkillSummary> {
  const record = asRecord(payload)
  const drafts = Array.isArray(payload)
    ? payload
    : Array.isArray(record.drafts)
      ? record.drafts
      : []

  return drafts
    .map((entry) => {
      const draft = asRecord(entry)
      const rawId = readString(draft.id) || String(draft.id ?? '')
      if (!rawId) return null
      const title = readString(draft.title) || `Procedural skill ${rawId}`
      const status = readString(draft.status) || 'draft'
      const agentKey = readString(draft.agent_key)
      const publishedName = readString(draft.published_skill_name)
      const content = readString(draft.draft_markdown)

      return {
        id: `procedural:${rawId}`,
        slug: `procedural-${slugify(publishedName || title || rawId)}`,
        name: publishedName || title,
        description: readString(draft.summary),
        author: agentKey || 'NyxHive',
        triggers: uniqueStrings([publishedName, title, agentKey]),
        tags: uniqueStrings(['procedural', status, agentKey]),
        homepage: null,
        category: 'Agent Memory',
        icon: '🧠',
        content,
        fileCount: content ? 1 : 0,
        sourcePath: draft.trace_id
          ? `trace:${readString(draft.trace_id)}`
          : `procedural:${rawId}`,
        installed: status !== 'rejected',
        enabled: status === 'published',
        builtin: false,
        security: {
          level: 'safe',
          flags: status === 'draft' ? ['draft'] : [],
          score: 0,
        },
      } satisfies SkillSummary
    })
    .filter((skill): skill is SkillSummary => skill !== null)
}

export function mergeSkillSources(
  ...sources: Array<Array<SkillSummary>>
): Array<SkillSummary> {
  const merged = new Map<string, SkillSummary>()
  for (const source of sources) {
    for (const skill of source) {
      if (!merged.has(skill.id)) merged.set(skill.id, skill)
    }
  }
  return [...merged.values()]
}

export function resolveSkillCategories(
  skills: Array<SkillSummary>,
): Array<string> {
  const known = new Set<string>(KNOWN_CATEGORIES)
  for (const skill of skills) {
    if (skill.category) known.add(skill.category)
  }
  return [...known]
}

export function matchesSearch(skill: SkillSummary, rawSearch: string): boolean {
  const search = rawSearch.trim().toLowerCase()
  if (!search) return true

  return [
    skill.id,
    skill.name,
    skill.description,
    skill.author,
    skill.category,
    ...skill.tags,
    ...skill.triggers,
  ]
    .join('\n')
    .toLowerCase()
    .includes(search)
}

export function sortSkills(skills: Array<SkillSummary>, sort: SkillsSort) {
  return [...skills].sort((left, right) => {
    if (sort === 'category') {
      const categoryCompare = left.category.localeCompare(right.category)
      if (categoryCompare !== 0) return categoryCompare
    }
    return left.name.localeCompare(right.name)
  })
}
