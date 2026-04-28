import { describe, expect, test } from 'bun:test'
import {
  buildAgentMemoryOverview,
  normalizeAgentMemoryBucket,
} from './agent-memory'

describe('agent memory workspace adapter', () => {
  test('builds an agent-first overview from runtime stores', () => {
    const overview = buildAgentMemoryOverview({
      bank: {
        categories: [
          { type: 'identity', label: 'Identity', count: 2 },
          { type: 'knowledge', label: 'Knowledge', count: 8 },
        ],
        recentMemories: [{ id: 1, content: 'Nyx owns runtime behavior' }],
        totalNodes: 2,
        totalEdges: 1,
        totalChunks: 8,
      },
      briefing: { briefing: 'Current briefing' },
      artifactStats: { total: 3, stale: 1 },
      knowledgeStats: { totalChunks: 8, compiledPages: 4 },
      digests: { pages: [{ id: 7, title: 'Harness digest' }] },
      proceduralSkills: {
        drafts: [{ id: 9, title: 'Quality gate loop' }],
        total: 6,
      },
    })

    expect(overview.totals).toEqual({
      graphNodes: 2,
      graphEdges: 1,
      knowledgeChunks: 8,
      compiledPages: 4,
      contextArtifacts: 3,
      proceduralSkills: 6,
    })
    expect(overview.briefing).toBe('Current briefing')
    expect(overview.categories.map((category) => category.type)).toContain(
      'context_artifacts',
    )
    expect(overview.categories.map((category) => category.type)).toContain(
      'knowledge_digests',
    )
    expect(overview.categories.map((category) => category.type)).toContain(
      'procedural_skills',
    )
  })

  test('normalizes virtual bucket payloads', () => {
    expect(
      normalizeAgentMemoryBucket('procedural_skills', {
        drafts: [{ id: 1 }, { id: 2 }],
        total: 9,
      }),
    ).toEqual({
      type: 'procedural_skills',
      items: [{ id: 1 }, { id: 2 }],
      total: 9,
    })

    expect(
      normalizeAgentMemoryBucket('context_artifacts', {
        artifacts: [{ id: 3 }],
      }),
    ).toEqual({
      type: 'context_artifacts',
      items: [{ id: 3 }],
      total: 1,
    })
  })
})
