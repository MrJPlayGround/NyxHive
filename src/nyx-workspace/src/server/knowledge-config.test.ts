import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  getKnowledgeBaseEffectiveRoot,
  readKnowledgeBaseConfig,
  writeKnowledgeBaseConfig,
} from './knowledge-config'

const originalWorkspaceHome = process.env.NYX_WORKSPACE_HOME
const originalKnowledgeDir = process.env.KNOWLEDGE_DIR
const tempDirs: Array<string> = []

afterEach(() => {
  if (originalWorkspaceHome === undefined) {
    delete process.env.NYX_WORKSPACE_HOME
  } else {
    process.env.NYX_WORKSPACE_HOME = originalWorkspaceHome
  }
  if (originalKnowledgeDir === undefined) {
    delete process.env.KNOWLEDGE_DIR
  } else {
    process.env.KNOWLEDGE_DIR = originalKnowledgeDir
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function createWorkspaceHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'nyx-knowledge-config-'))
  tempDirs.push(root)
  process.env.NYX_WORKSPACE_HOME = root
  delete process.env.KNOWLEDGE_DIR
  return root
}

describe('knowledge config', () => {
  test('stores knowledge config under the Nyx workspace home', () => {
    createWorkspaceHome()

    writeKnowledgeBaseConfig({
      source: { type: 'local', path: '/tmp/nyx-memory' },
    })

    expect(readKnowledgeBaseConfig()).toEqual({
      source: { type: 'local', path: '/tmp/nyx-memory' },
    })
  })

  test('uses the Nyx memory folder as the default effective root', () => {
    const root = createWorkspaceHome()
    const memoryRoot = join(root, 'memory')
    mkdirSync(memoryRoot, { recursive: true })

    expect(getKnowledgeBaseEffectiveRoot()).toBe(memoryRoot)
  })
})
