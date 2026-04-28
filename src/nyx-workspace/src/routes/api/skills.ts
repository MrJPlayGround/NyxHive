import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  BEARER_TOKEN,
  NYX_API_URL,
  NYX_UPGRADE_INSTRUCTIONS,
  ensureGatewayProbed,
  getCapabilities,
} from '../../server/gateway-capabilities'
import { createGatewayAuthHeaders } from '../../server/gateway-auth-headers'
import { requireJsonContentType } from '../../server/rate-limit'
import { createCapabilityUnavailablePayload } from '@/lib/feature-gates'
import { readMarketplaceSkillDrafts } from '../../server/marketplace-skill-drafts'
import {
  asRecord,
  matchesSearch,
  mergeSkillSources,
  normalizeProceduralSkills,
  normalizeSkill,
  readLocalSkills,
  resolveSkillCategories,
  sortSkills,
  type SkillSummary,
  type SkillsSort,
} from '../../server/skills-catalog'

type SkillsTab = 'installed' | 'marketplace' | 'featured'

const FEATURED_SKILLS: Array<{ id: string; group: string }> = [
  { id: 'dbalve/fast-io', group: 'Most Popular' },
  { id: 'okoddcat/gitflow', group: 'Most Popular' },
  { id: 'atomtanstudio/craft-do', group: 'Most Popular' },
  { id: 'bro3886/gtasks-cli', group: 'New This Week' },
  { id: 'vvardhan14/pokerpal', group: 'New This Week' },
  {
    id: 'veeramanikandanr48/docker-containerization',
    group: 'Developer Tools',
  },
  { id: 'veeramanikandanr48/azure-auth', group: 'Developer Tools' },
  { id: 'dbalve/fastio-skills', group: 'Productivity' },
  { id: 'gillberto1/moltwallet', group: 'Productivity' },
  { id: 'veeramanikandanr48/backtest-expert', group: 'Productivity' },
]

async function fetchNyxSkills(): Promise<Array<SkillSummary>> {
  const response = await fetch(`${NYX_API_URL}/api/skills`, {
    headers: createGatewayAuthHeaders(BEARER_TOKEN),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(body || `Nyx skills request failed (${response.status})`)
  }

  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) return []

  const payload = (await response.json()) as unknown
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(asRecord(payload).items)
      ? (asRecord(payload).items as Array<unknown>)
      : Array.isArray(asRecord(payload).skills)
        ? (asRecord(payload).skills as Array<unknown>)
        : []

  return items
    .map((entry) => normalizeSkill(entry))
    .filter((entry): entry is SkillSummary => entry !== null)
}

async function fetchProceduralSkills(): Promise<Array<SkillSummary>> {
  const response = await fetch(
    `${NYX_API_URL}/api/skills/procedural?limit=200&sort=needs_audit`,
    {
      headers: createGatewayAuthHeaders(BEARER_TOKEN),
    },
  )
  if (!response.ok) return []

  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) return []

  return normalizeProceduralSkills(await response.json())
}

async function fetchSkillSources(): Promise<Array<SkillSummary>> {
  const [localSkills, draftSkills, gatewaySkills, proceduralSkills] =
    await Promise.all([
      Promise.resolve(readLocalSkills()),
      Promise.resolve(readMarketplaceSkillDrafts()),
      fetchNyxSkills().catch(() => []),
      fetchProceduralSkills().catch(() => []),
    ])

  return mergeSkillSources(
    localSkills,
    draftSkills,
    proceduralSkills,
    gatewaySkills,
  )
}

export const Route = createFileRoute('/api/skills')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        await ensureGatewayProbed()

        try {
          const url = new URL(request.url)
          const tabParam = url.searchParams.get('tab')
          const tab: SkillsTab =
            tabParam === 'installed' ||
            tabParam === 'marketplace' ||
            tabParam === 'featured'
              ? tabParam
              : 'installed'
          const rawSearch = (url.searchParams.get('search') || '').trim()
          const category = (url.searchParams.get('category') || 'All').trim()
          const sortParam = (url.searchParams.get('sort') || 'name').trim()
          const sort: SkillsSort =
            sortParam === 'category' || sortParam === 'name'
              ? sortParam
              : 'name'
          const page = Math.max(1, Number(url.searchParams.get('page') || '1'))
          const limit = Math.min(
            60,
            Math.max(1, Number(url.searchParams.get('limit') || '30')),
          )

          const sourceItems = await fetchSkillSources()
          const installedLookup = new Set(
            sourceItems
              .filter((skill) => skill.installed)
              .map((skill) => skill.id),
          )

          const filteredByTab = sourceItems.filter((skill) => {
            if (tab === 'featured') return true
            if (tab === 'installed') return skill.installed
            return true
          })

          const featuredLookup = new Map(
            FEATURED_SKILLS.map((entry) => [entry.id, entry.group]),
          )

          const filtered = sortSkills(
            filteredByTab
              .map((skill) => ({
                ...skill,
                installed: installedLookup.has(skill.id),
                featuredGroup: featuredLookup.get(skill.id),
              }))
              .filter((skill) => {
                if (tab === 'featured' && !skill.featuredGroup) return false
                if (!matchesSearch(skill, rawSearch)) return false
                if (category !== 'All' && skill.category !== category) {
                  return false
                }
                return true
              }),
            sort,
          )

          const total = filtered.length
          const start = (page - 1) * limit
          const skills = filtered.slice(start, start + limit)

          return json({
            skills,
            total,
            page,
            categories: resolveSkillCategories(sourceItems),
          })
        } catch (err) {
          return json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          )
        }
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        await ensureGatewayProbed()
        if (!getCapabilities().skills) {
          return json(
            {
              ...createCapabilityUnavailablePayload('skills', {
                error: `Gateway does not support /api/skills. ${NYX_UPGRADE_INSTRUCTIONS}`,
              }),
            },
            { status: 503 },
          )
        }
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        try {
          const body = (await request.json()) as {
            action?: string
            identifier?: string
            name?: string
            category?: string
            force?: boolean
            enabled?: boolean
          }
          const action = (body.action || 'install').trim()

          let endpoint: string
          let payload: Record<string, unknown>

          if (action === 'uninstall') {
            endpoint = '/api/skills/uninstall'
            payload = { name: body.name || body.identifier || '' }
          } else if (action === 'toggle') {
            endpoint = '/api/skills/toggle'
            payload = {
              name: body.name || body.identifier || '',
              enabled: body.enabled,
            }
          } else {
            endpoint = '/api/skills/install'
            payload = {
              identifier: body.identifier || '',
              category: body.category || '',
              force: Boolean(body.force),
            }
          }

          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...createGatewayAuthHeaders(BEARER_TOKEN),
          }

          const response = await fetch(`${NYX_API_URL}${endpoint}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(120_000),
          })

          const result = await response.json()
          return json(result, { status: response.status })
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
