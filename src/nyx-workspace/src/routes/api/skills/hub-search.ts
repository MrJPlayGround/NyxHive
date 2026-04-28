import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'

const execFileAsync = promisify(execFile)

type HubSkill = {
  id: string
  name: string
  description: string
  author: string
  category: string
  tags: Array<string>
  source: string
  identifier: string
  trust_level: string
  repo: string
  homepage: string
  installCommand: string
  installed: boolean
}

const CURATED_FALLBACK_SKILLS: Array<HubSkill> = [
  {
    id: 'pingdotgg/t3code',
    name: 't3code harness patterns',
    description:
      'Agent harness workflow patterns for planning, tool use, and terminal coding loops.',
    author: 'pingdotgg',
    category: 'Coding Agents',
    tags: ['agent', 'harness', 'codex', 'workflow'],
    source: 'github',
    identifier: 'https://github.com/pingdotgg/t3code',
    trust_level: 'community',
    repo: 'pingdotgg/t3code',
    homepage: 'https://github.com/pingdotgg/t3code',
    installCommand: '',
    installed: false,
  },
  {
    id: 'tailcallhq/forgecode',
    name: 'ForgeCode benchmark harness patterns',
    description:
      'Terminal-bench oriented harness patterns for planning, execution, and verification loops.',
    author: 'tailcallhq',
    category: 'Coding Agents',
    tags: ['agent', 'harness', 'terminal-bench', 'verification'],
    source: 'github',
    identifier: 'https://github.com/tailcallhq/forgecode',
    trust_level: 'community',
    repo: 'tailcallhq/forgecode',
    homepage: 'https://github.com/tailcallhq/forgecode',
    installCommand: '',
    installed: false,
  },
  {
    id: 'openclaw/openclaw',
    name: 'OpenClaw workspace patterns',
    description:
      'Open agent workspace patterns for tool routing, context, and development flow.',
    author: 'openclaw',
    category: 'Coding Agents',
    tags: ['agent', 'workspace', 'harness', 'tools'],
    source: 'github',
    identifier: 'https://github.com/openclaw/openclaw',
    trust_level: 'community',
    repo: 'openclaw/openclaw',
    homepage: 'https://github.com/openclaw/openclaw',
    installCommand: '',
    installed: false,
  },
  {
    id: 'outsourc-e/hermes-workspace',
    name: 'Imported workspace UI patterns',
    description:
      'Workspace shell patterns for chat, memory, skills, profiles, and monitoring. Needs Nyx adaptation.',
    author: 'outsourc-e',
    category: 'Productivity',
    tags: ['workspace', 'source-import', 'ui', 'needs-adaptation'],
    source: 'github',
    identifier: 'https://github.com/outsourc-e/hermes-workspace',
    trust_level: 'community',
    repo: 'outsourc-e/hermes-workspace',
    homepage: 'https://github.com/outsourc-e/hermes-workspace',
    installCommand: '',
    installed: false,
  },
]

function fallbackResults(query: string, limit: number): Array<HubSkill> {
  const needle = query.trim().toLowerCase()
  const results = needle
    ? CURATED_FALLBACK_SKILLS.filter((skill) =>
        [
          skill.id,
          skill.name,
          skill.description,
          skill.author,
          skill.category,
          ...skill.tags,
        ]
          .join('\n')
          .toLowerCase()
          .includes(needle),
      )
    : CURATED_FALLBACK_SKILLS

  return results.slice(0, limit)
}

export const Route = createFileRoute('/api/skills/hub-search')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const url = new URL(request.url)
          const query = (url.searchParams.get('q') || '').trim()
          const limit = Math.min(
            50,
            Math.max(1, Number(url.searchParams.get('limit') || '20')),
          )
          const source = (
            url.searchParams.get('source') || 'all'
          ).trim()

          if (!query) {
            const results = fallbackResults('', limit)
            return json({
              results,
              source: 'nyx-curated',
              total: results.length,
            })
          }

          // Call the Python skills-search wrapper which uses nyx-agent's
          // unified_search across all registries (official, skills.sh,
          // well-known GitHub, LobeHub, etc.)
          const scriptPath = path.join(
            process.cwd(),
            'scripts/skills-search.py',
          )

          const { stdout } = await execFileAsync(
            'python3',
            [scriptPath, query, String(limit), source],
            {
              timeout: 30_000,
              maxBuffer: 1024 * 1024 * 2,
            },
          )

          const result = JSON.parse(stdout.trim())
          return json(result)
        } catch (error) {
          const url = new URL(request.url)
          const query = (url.searchParams.get('q') || '').trim()
          const limit = Math.min(
            50,
            Math.max(1, Number(url.searchParams.get('limit') || '20')),
          )
          const results = fallbackResults(query, limit)
          return json({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : 'Failed to search skills hub',
            results,
            source: 'nyx-curated-fallback',
            total: results.length,
          })
        }
      },
    },
  },
})
