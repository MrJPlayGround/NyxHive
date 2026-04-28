import { existsSync, readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { loadConfig } from '../config.js'
import { scaffoldAstraTradingInstance } from '../workspaces/scaffold.js'

describe('Astra Trading instance scaffold', () => {
  test('creates an isolated NyxHive agent instance skeleton', () => {
    const root = mkdtempSync(join(tmpdir(), 'astra-trading-'))

    const result = scaffoldAstraTradingInstance({
      targetRoot: root,
      engineRoot: '/home/user/dev/nyxhive',
      engineCommit: 'abc123',
    })

    expect(result.root).toBe(root)
    expect(existsSync(join(root, '.nyxhive', 'workspace.toml'))).toBe(true)
    expect(existsSync(join(root, '.nyxhive', 'config.toml'))).toBe(true)
    expect(existsSync(join(root, '.nyxhive', 'engine.lock'))).toBe(true)
    expect(existsSync(join(root, '.nyxhive', 'souls', 'instance.yaml'))).toBe(true)
    expect(existsSync(join(root, 'src', 'strategies', '.gitkeep'))).toBe(true)
    expect(existsSync(join(root, 'src', 'risk', '.gitkeep'))).toBe(true)
    expect(existsSync(join(root, 'src', 'tools', '.gitkeep'))).toBe(true)
    expect(existsSync(join(root, 'src', 'evals', '.gitkeep'))).toBe(true)

    const workspace = readFileSync(join(root, '.nyxhive', 'workspace.toml'), 'utf-8')
    const config = readFileSync(join(root, '.nyxhive', 'config.toml'), 'utf-8')

    expect(workspace).toContain('id = "astra-trading"')
    expect(workspace).toContain('kind = "agent"')
    expect(workspace).toContain('data_namespace = "astra-trading"')
    expect(config).toContain('[agents.astra]')
    expect(config).toContain('working_directory = ".."')
  })

  test('creates a backend config that passes NyxHive validation', () => {
    const root = mkdtempSync(join(tmpdir(), 'astra-trading-'))

    scaffoldAstraTradingInstance({
      targetRoot: root,
      engineRoot: '/home/user/dev/nyxhive',
      engineCommit: 'abc123',
    })

    const config = loadConfig(join(root, '.nyxhive', 'config.toml'))

    expect(config.daemon.name).toBe('Astra Trading')
    expect(config.daemon.data_dir).toBe(join(root, '.nyxhive', 'data'))
    expect(config.daemon.primary_agent).toBe('astra')
    expect(config.server.port).toBe(3782)
    expect(config.server.api_key_env).toBe('ASTRA_TRADING_API_KEY')
    expect(config.agents.astra.role).toBe('lead')
    expect(config.agents.astra.provider).toBe('openai')
    expect(config.agents.astra.model).toBe('gpt-5.5')
    expect(config.agents.astra.always_cli).toBe(true)
    expect(config.agents.astra.cli_fallback).toBe('codex')
    expect(config.agents.astra.effort).toBe('high')
    expect(config.agents.astra.working_directory).toBe('..')
    expect(config.providers.openrouter.api_key_env).toBe('OPENROUTER_API_KEY')
    expect(config.providers.openai.runtime).toBe('codex_app_server')
    expect(config.routing.classifier_provider).toBe('openrouter')
  })
})
