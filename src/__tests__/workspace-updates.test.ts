import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  compareEngineLock,
  readEngineLock,
  writeEngineLock,
} from '../workspaces/updates.js'

describe('workspace engine updates', () => {
  test('reads workspace engine lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'nyxhive-engine-lock-'))
    mkdirSync(join(root, '.nyxhive'), { recursive: true })
    writeFileSync(join(root, '.nyxhive', 'engine.lock'), `
[engine]
source = "local-git"
path = "/engine"
ref = "master"
commit = "abc123"
`)

    const lock = readEngineLock(root)

    expect(lock?.engine.commit).toBe('abc123')
  })

  test('reports update_available when engine commit differs', () => {
    const root = mkdtempSync(join(tmpdir(), 'nyxhive-engine-lock-'))
    mkdirSync(join(root, '.nyxhive'), { recursive: true })
    writeFileSync(join(root, '.nyxhive', 'engine.lock'), `
[engine]
source = "local-git"
path = "/engine"
ref = "master"
commit = "abc123"
`)

    const status = compareEngineLock(root, {
      source: 'local-git',
      path: '/engine',
      ref: 'master',
      commit: 'def456',
    })

    expect(status.state).toBe('update_available')
    expect(status.current.commit).toBe('def456')
    expect(status.locked?.engine.commit).toBe('abc123')
  })

  test('writes an engine lock that can be acknowledged by workspaces', () => {
    const root = mkdtempSync(join(tmpdir(), 'nyxhive-engine-lock-'))

    writeEngineLock(root, {
      source: 'local-git',
      path: '/engine',
      ref: 'master',
      commit: 'def456',
    })

    const raw = readFileSync(join(root, '.nyxhive', 'engine.lock'), 'utf-8')
    const status = compareEngineLock(root, {
      source: 'local-git',
      path: '/engine',
      ref: 'master',
      commit: 'def456',
    })

    expect(raw).toContain('commit = "def456"')
    expect(status.state).toBe('current')
  })
})
