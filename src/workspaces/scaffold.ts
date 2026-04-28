import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeEngineLock } from './updates.js'

export interface ScaffoldAstraTradingInstanceOptions {
  targetRoot: string
  engineRoot: string
  engineCommit: string
}

export interface ScaffoldResult {
  root: string
  files: string[]
}

function write(path: string, content = ''): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

export function scaffoldAstraTradingInstance(
  options: ScaffoldAstraTradingInstanceOptions,
): ScaffoldResult {
  const { targetRoot, engineRoot, engineCommit } = options
  const files: string[] = []
  const apiKey = `astra_${randomUUID().replace(/-/g, '')}`

  mkdirSync(join(targetRoot, '.nyxhive', 'souls'), { recursive: true })
  mkdirSync(join(targetRoot, 'src', 'strategies'), { recursive: true })
  mkdirSync(join(targetRoot, 'src', 'risk'), { recursive: true })
  mkdirSync(join(targetRoot, 'src', 'tools'), { recursive: true })
  mkdirSync(join(targetRoot, 'src', 'evals'), { recursive: true })

  files.push(write(join(targetRoot, '.nyxhive', 'workspace.toml'), `id = "astra-trading"
kind = "agent"
display_name = "Astra Trading"
aliases = ["astra", "trading"]

[engine]
source = "local-git"
path = "${engineRoot}"
ref = "master"
constraint = ">=0.1 <0.2"

[runtime]
instance_id = "astra-trading"
data_namespace = "astra-trading"
config = ".nyxhive/config.toml"
api_url = "http://127.0.0.1:3782"
api_key_env = "ASTRA_TRADING_API_KEY"
app_port = 3783
app_host = "127.0.0.1"
agent_name = "Astra"
tmux_session = "astra-trading-workspace"
vault_root = "${targetRoot}/knowledge"
agents = ["astra"]
`))

  files.push(write(join(targetRoot, '.nyxhive', 'config.toml'), `allowed_directories = ["${targetRoot}"]

[daemon]
name = "Astra Trading"
log_level = "info"
data_dir = "./data"
primary_agent = "astra"
workflow_mode = "direct"

[server]
port = 3782
api_key_env = "ASTRA_TRADING_API_KEY"
require_auth = true
request_timeout_ms = 120000

[agents.astra]
name = "Astra"
role = "lead"
provider = "openai"
model = "gpt-5.5"
always_cli = true
cli_fallback = "codex"
working_directory = ".."
soul = ".nyxhive/souls/instance.yaml"
agentic_mode = "strict"
effort = "high"
capabilities = ["tool_use", "trading-research", "risk-review", "strategy-evaluation"]
timeout_ms = 7200000
context_strategy = { max_messages = 20, include_summary = true }

[providers.openrouter]
api_key_env = "OPENROUTER_API_KEY"

[providers.openai]
auth_mode = "codex"
runtime = "codex_app_server"
fallback = "none"

[routing]
classifier_model = "google/gemini-2.5-flash"
classifier_provider = "openrouter"
cli_escalation_tasks = ["coding", "code_review", "analysis", "expert"]

[context]
max_history = 120
summary_threshold = 40
summary_max_tokens = 1500
history_budget_ratio = 0.5

[scheduler]
enabled = false
task_profile = "trading"

[trading]
enabled = true
timezone = "Europe/Lisbon"
default_market = "crypto"
`))

  files.push(write(join(targetRoot, '.nyxhive', '.env'), `ASTRA_TRADING_API_KEY=${apiKey}
OPENROUTER_API_KEY=
`))

  files.push(write(join(targetRoot, '.nyxhive', 'souls', 'instance.yaml'), `name: Astra
role: Trading desk operator
identity: >
  Astra is an isolated NyxHive instance for trading research, risk review,
  strategy evaluation, and market workflow automation.
boundaries:
  - Trading logic belongs in this workspace, not NyxHive core.
  - NyxHive core supplies runtime, queue, tools, memory plumbing, and updates.
  - No live trading or broker action without explicit user approval.
`))

  files.push(write(join(targetRoot, 'README.md'), `# Astra Trading

Astra is an isolated NyxHive agent instance for trading workflows.

NyxHive is the engine. This workspace owns trading strategy, risk rules, tools,
evals, and Astra-specific memory.

## Update Check

\`\`\`bash
nyx updates check astra-trading
\`\`\`
`))

  for (const dir of ['strategies', 'risk', 'tools', 'evals']) {
    files.push(write(join(targetRoot, 'src', dir, '.gitkeep')))
  }

  writeEngineLock(targetRoot, {
    source: 'local-git',
    path: engineRoot,
    ref: 'master',
    commit: engineCommit,
  })
  files.push(join(targetRoot, '.nyxhive', 'engine.lock'))

  return { root: targetRoot, files }
}
