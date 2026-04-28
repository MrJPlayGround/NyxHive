import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { getNyxWorkspaceHome } from './workspace-home'
import {
  guessCategory,
  readString,
  readStringArray,
  slugify,
  type SkillSummary,
} from './skills-catalog'

export type MarketplaceSkillApplyInput = {
  id?: string
  identifier?: string
  name?: string
  description?: string
  author?: string
  category?: string
  tags?: Array<string>
  triggers?: Array<string>
  homepage?: string | null
  source?: string
  sourcePath?: string
  content?: string
  installCommand?: string
  trust_level?: string
  trust?: string
}

type MarketplaceCompatibility = 'native' | 'portable' | 'needs-adaptation'

type MarketplaceDraftMetadata = {
  id: string
  slug: string
  name: string
  description: string
  author: string
  category: string
  tags: Array<string>
  triggers: Array<string>
  homepage: string | null
  source: string
  sourcePath: string
  content: string
  compatibility: MarketplaceCompatibility
  enabled: false
  createdAt: string
  updatedAt: string
}

export type MarketplaceApplyResult = {
  ok: true
  draft: MarketplaceDraftMetadata & {
    draftPath: string
    skillPath: string
  }
  existed: boolean
}

function getDraftsRoot(): string {
  return join(getNyxWorkspaceHome(), 'skill-drafts')
}

function uniqueStrings(values: Array<string>): Array<string> {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function inferCompatibility(input: MarketplaceSkillApplyInput): MarketplaceCompatibility {
  const searchable = [
    input.id,
    input.identifier,
    input.name,
    input.description,
    input.source,
    input.sourcePath,
    input.content,
    input.installCommand,
    ...(input.tags ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  if (searchable.includes('nyxhive') || searchable.includes('skill.md')) {
    return 'native'
  }
  if (
    searchable.includes('claude') ||
    searchable.includes('anthropic') ||
    searchable.includes('hermes') ||
    searchable.includes('hook') ||
    searchable.includes('mcp')
  ) {
    return 'needs-adaptation'
  }
  return 'portable'
}

function normalizeApplyInput(
  input: MarketplaceSkillApplyInput,
): MarketplaceDraftMetadata {
  const rawId = readString(input.identifier) || readString(input.id)
  const name = readString(input.name) || rawId
  if (!name) throw new Error('Skill name or identifier required')

  const source = readString(input.source) || 'marketplace'
  const slug = slugify(`${source}-${rawId || name}`)
  const tags = uniqueStrings([
    'marketplace-draft',
    source,
    readString(input.trust_level),
    readString(input.trust),
    ...readStringArray(input.tags),
  ])
  const description = readString(input.description)
  const category =
    readString(input.category) ||
    guessCategory({
      id: rawId,
      name,
      description,
      source,
      tags,
    })
  const now = new Date().toISOString()

  return {
    id: `marketplace:${slug}`,
    slug,
    name,
    description,
    author: readString(input.author) || source || 'Marketplace',
    category,
    tags,
    triggers: uniqueStrings([
      rawId,
      name,
      source,
      ...readStringArray(input.triggers),
    ]),
    homepage: readString(input.homepage) || null,
    source,
    sourcePath:
      readString(input.sourcePath) ||
      readString(input.identifier) ||
      readString(input.id) ||
      source,
    content: readString(input.content),
    compatibility: inferCompatibility(input),
    enabled: false,
    createdAt: now,
    updatedAt: now,
  }
}

function buildDraftMarkdown(metadata: MarketplaceDraftMetadata): string {
  const description = metadata.description || 'Marketplace skill draft.'
  const sourceLink = metadata.homepage || metadata.sourcePath
  const content = metadata.content || description

  return `---
name: ${metadata.slug}
description: ${description.replace(/\n/g, ' ')}
nyx_status: draft
nyx_enabled: false
source: marketplace
source_id: ${metadata.sourcePath}
source_name: ${metadata.source}
compatibility: ${metadata.compatibility}
---

# ${metadata.name}

${description}

## Source

- Provider: ${metadata.source}
- Identifier: ${metadata.sourcePath}
- Author: ${metadata.author}
- Category: ${metadata.category}
${sourceLink ? `- Link: ${sourceLink}` : ''}

## Nyx Adaptation Checklist

- [ ] Review source instructions for provider-specific assumptions.
- [ ] Remove Claude, Hermes, hook, shell, or secret assumptions that do not apply to NyxHive.
- [ ] Convert reusable behavior into a concise NyxHive skill.
- [ ] Enable only after the adapted draft is reviewed.

## Source Material

${content}
`
}

export function applyMarketplaceSkillDraft(
  input: MarketplaceSkillApplyInput,
): MarketplaceApplyResult {
  const normalized = normalizeApplyInput(input)
  const draftsRoot = getDraftsRoot()
  const draftDir = join(draftsRoot, normalized.slug)
  const metadataPath = join(draftDir, 'draft.json')
  const skillPath = join(draftDir, 'SKILL.md')
  const existed = existsSync(metadataPath) || existsSync(skillPath)

  let createdAt = normalized.createdAt
  if (existsSync(metadataPath)) {
    try {
      const existing = JSON.parse(
        readFileSync(metadataPath, 'utf-8'),
      ) as Partial<MarketplaceDraftMetadata>
      if (typeof existing.createdAt === 'string') createdAt = existing.createdAt
    } catch {
      // keep new timestamp when existing metadata is unreadable
    }
  }

  const metadata = {
    ...normalized,
    createdAt,
    updatedAt: new Date().toISOString(),
  }

  mkdirSync(draftDir, { recursive: true })
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf-8')
  writeFileSync(skillPath, buildDraftMarkdown(metadata), 'utf-8')

  return {
    ok: true,
    draft: {
      ...metadata,
      draftPath: metadataPath,
      skillPath,
    },
    existed,
  }
}

export function readMarketplaceSkillDrafts(): Array<SkillSummary> {
  const draftsRoot = getDraftsRoot()
  if (!existsSync(draftsRoot)) return []

  const skills: Array<SkillSummary> = []
  for (const entry of readdirSync(draftsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const draftDir = join(draftsRoot, entry.name)
    const metadataPath = join(draftDir, 'draft.json')
    const skillPath = join(draftDir, 'SKILL.md')
    if (!existsSync(metadataPath) || !existsSync(skillPath)) continue

    try {
      const metadata = JSON.parse(
        readFileSync(metadataPath, 'utf-8'),
      ) as MarketplaceDraftMetadata
      const content = readFileSync(skillPath, 'utf-8')
      const securityLevel =
        metadata.compatibility === 'needs-adaptation' ? 'medium' : 'low'

      skills.push({
        id: metadata.id,
        slug: metadata.slug,
        name: metadata.name,
        description: metadata.description,
        author: metadata.author,
        triggers: metadata.triggers,
        tags: metadata.tags,
        homepage: metadata.homepage,
        category: metadata.category,
        icon: '🧩',
        content,
        fileCount: 1,
        sourcePath: skillPath,
        installed: true,
        enabled: false,
        builtin: false,
        security: {
          level: securityLevel,
          flags: [
            'marketplace draft',
            metadata.compatibility === 'needs-adaptation'
              ? 'needs adaptation'
              : 'disabled until reviewed',
          ],
          score: metadata.compatibility === 'needs-adaptation' ? 40 : 15,
        },
      })
    } catch {
      // Ignore broken drafts; the apply route will rewrite them deterministically.
    }
  }

  return skills
}
