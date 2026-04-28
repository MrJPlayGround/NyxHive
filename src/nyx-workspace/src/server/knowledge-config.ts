import fs from 'node:fs'
import path from 'node:path'
import { getNyxWorkspaceHome, resolveHomePath } from './workspace-home'

export type KnowledgeBaseSource =
  | { type: 'local'; path: string }
  | { type: 'github'; repo: string; branch: string; path: string }

export type KnowledgeBaseConfig = {
  source: KnowledgeBaseSource
}

const DEFAULT_CONFIG: KnowledgeBaseConfig = {
  source: { type: 'local', path: '' },
}

function getConfigPath(): string {
  return path.join(getNyxWorkspaceHome(), 'knowledge-config.json')
}

export function readKnowledgeBaseConfig(): KnowledgeBaseConfig {
  const configPath = getConfigPath()
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<KnowledgeBaseConfig>
      return {
        source: parsed.source ?? DEFAULT_CONFIG.source,
      }
    }
  } catch {
    // ignore parse errors, fall back to default config
  }
  return DEFAULT_CONFIG
}

export function writeKnowledgeBaseConfig(config: KnowledgeBaseConfig): void {
  const configPath = getConfigPath()
  const dir = path.dirname(configPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

export function getKnowledgeBaseEffectiveRoot(): string {
  const config = readKnowledgeBaseConfig()
  if (config.source.type === 'local') {
    const p = config.source.path.trim()
    if (p) return resolveHomePath(p)
  }
  // fallback: legacy env var or default
  if (process.env.KNOWLEDGE_DIR) return path.resolve(process.env.KNOWLEDGE_DIR)
  const nyxKnowledge = path.join(getNyxWorkspaceHome(), 'knowledge')
  if (fs.existsSync(nyxKnowledge)) return nyxKnowledge
  const nyxMemory = path.join(getNyxWorkspaceHome(), 'memory')
  if (fs.existsSync(nyxMemory)) return nyxMemory
  return nyxKnowledge
}
