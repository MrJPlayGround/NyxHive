import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import {
  mergeSkillSources,
  normalizeProceduralSkills,
  readLocalSkills,
  resolveSkillCategories,
} from './skills-catalog'

describe('workspace skills catalog', () => {
  test('reads repo-local SKILL.md files as installed NyxHive skills', () => {
    const root = mkdtempSync(join(tmpdir(), 'nyx-skills-'))
    const skillsRoot = join(root, 'skills')
    const skillRoot = join(skillsRoot, 'codex-harness')
    mkdirSync(skillRoot, { recursive: true })
    writeFileSync(
      join(skillRoot, 'SKILL.md'),
      `---
name: codex-harness
description: Use when working on Codex runtime behavior
---

# Codex Harness

Port ideas, not assumptions.
`,
    )

    try {
      const skills = readLocalSkills({ roots: [skillsRoot] })
      expect(skills).toHaveLength(1)
      expect(skills[0]).toMatchObject({
        id: 'local:codex-harness',
        name: 'codex-harness',
        description: 'Use when working on Codex runtime behavior',
        author: 'NyxHive',
        installed: true,
        enabled: true,
        builtin: true,
        category: 'Coding Agents',
      })
      expect(skills[0]?.content).toContain('Port ideas, not assumptions.')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('maps learned procedural drafts into agent memory skills', () => {
    const skills = normalizeProceduralSkills({
      drafts: [
        {
          id: 7,
          agent_key: 'nyx',
          title: 'Use project verification gates',
          summary: 'Prefer project-specific verification commands.',
          draft_markdown: '# Verification gates\n\nRun configured gates.',
          status: 'published',
          published_skill_name: 'project-verification-gates',
          trace_id: 'trace-123',
        },
      ],
    })

    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      id: 'procedural:7',
      slug: 'procedural-project-verification-gates',
      name: 'project-verification-gates',
      author: 'nyx',
      category: 'Agent Memory',
      installed: true,
      enabled: true,
      sourcePath: 'trace:trace-123',
    })
  })

  test('merges categories and deduplicates sources by id', () => {
    const local = readLocalSkills({ roots: [] })
    const procedural = normalizeProceduralSkills({
      drafts: [
        {
          id: 1,
          title: 'Memory routing',
          summary: 'Route memory for agents.',
          draft_markdown: '# Memory routing',
          status: 'draft',
        },
      ],
    })

    const merged = mergeSkillSources(local, procedural, procedural)
    expect(merged).toHaveLength(1)
    expect(resolveSkillCategories(merged)).toContain('Agent Memory')
  })
})
