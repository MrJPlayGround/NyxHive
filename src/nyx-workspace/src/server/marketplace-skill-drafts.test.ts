import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  applyMarketplaceSkillDraft,
  readMarketplaceSkillDrafts,
} from './marketplace-skill-drafts'

const originalWorkspaceHome = process.env.NYX_WORKSPACE_HOME

afterEach(() => {
  if (originalWorkspaceHome === undefined) {
    delete process.env.NYX_WORKSPACE_HOME
  } else {
    process.env.NYX_WORKSPACE_HOME = originalWorkspaceHome
  }
})

function withTempWorkspaceHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'nyx-marketplace-drafts-'))
  process.env.NYX_WORKSPACE_HOME = root
  return root
}

describe('marketplace skill drafts', () => {
  test('applies a marketplace skill as a disabled Nyx draft', () => {
    const root = withTempWorkspaceHome()

    try {
      const result = applyMarketplaceSkillDraft({
        id: 'acme/browser-helper',
        name: 'Browser Helper',
        description: 'Navigate browser workflows.',
        author: 'acme',
        category: 'Browser & Automation',
        source: 'github',
        tags: ['browser', 'automation'],
        homepage: 'https://github.com/acme/browser-helper',
        content: '# Browser Helper\n\nUse Playwright carefully.',
      })

      expect(result.ok).toBe(true)
      expect(result.existed).toBe(false)
      expect(result.draft.enabled).toBe(false)
      expect(result.draft.compatibility).toBe('portable')
      expect(result.draft.skillPath).toContain('github-acme-browser-helper')

      const markdown = readFileSync(result.draft.skillPath, 'utf-8')
      expect(markdown).toContain('nyx_status: draft')
      expect(markdown).toContain('nyx_enabled: false')
      expect(markdown).toContain('## Nyx Adaptation Checklist')

      const drafts = readMarketplaceSkillDrafts()
      expect(drafts).toHaveLength(1)
      expect(drafts[0]).toMatchObject({
        id: 'marketplace:github-acme-browser-helper',
        name: 'Browser Helper',
        installed: true,
        enabled: false,
        category: 'Browser & Automation',
      })
      expect(drafts[0]?.security.flags).toContain('disabled until reviewed')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('marks Claude and Hermes marketplace imports as needing adaptation', () => {
    const root = withTempWorkspaceHome()

    try {
      const result = applyMarketplaceSkillDraft({
        identifier: 'claude-code-hook-pack',
        name: 'Claude Hook Pack',
        description: 'Claude Code hooks for shell automation.',
        source: 'claude-marketplace',
        installCommand: 'claude install claude-code-hook-pack',
      })

      expect(result.draft.compatibility).toBe('needs-adaptation')
      const [draft] = readMarketplaceSkillDrafts()
      expect(draft?.security.level).toBe('medium')
      expect(draft?.security.flags).toContain('needs adaptation')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('reapplying the same marketplace skill is idempotent', () => {
    const root = withTempWorkspaceHome()

    try {
      const first = applyMarketplaceSkillDraft({
        id: 'skills/foo',
        name: 'Foo',
        source: 'skills-hub',
      })
      const second = applyMarketplaceSkillDraft({
        id: 'skills/foo',
        name: 'Foo',
        source: 'skills-hub',
      })

      expect(first.existed).toBe(false)
      expect(second.existed).toBe(true)
      expect(readMarketplaceSkillDrafts()).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
