import { defineCommand } from 'citty'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import pc from 'picocolors'
import { scaffoldAstraTradingInstance } from '../../workspaces/scaffold.js'
import {
  loadWorkspaceRegistry,
  saveWorkspaceRegistry,
  workspaceRegistryPath,
} from '../../workspaces/registry-store.js'
import { getCurrentEngineIdentity } from '../../workspaces/updates.js'
import {
  buildWorkspaceStartCommand,
  listWorkspaceProfiles,
  profileSummary,
  resolveWorkspaceProfile,
} from '../lib/workspace-profiles.js'

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8' }).trim()
}

function tmuxHas(session: string): boolean {
  try {
    run('tmux', ['has-session', '-t', session])
    return true
  } catch {
    return false
  }
}

function listenPid(port: number): string | null {
  try {
    const pid = run('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)[0]
    return pid || null
  } catch {
    return null
  }
}

function hasBinary(binary: string): boolean {
  try {
    run('which', [binary])
    return true
  } catch {
    return false
  }
}

const list = defineCommand({
  meta: { name: 'list', description: 'List workspace profiles' },
  run() {
    for (const profile of listWorkspaceProfiles()) {
      console.log(`  ${profileSummary(profile)}`)
    }
  },
})

const status = defineCommand({
  meta: { name: 'status', description: 'Show workspace profile status' },
  args: {
    profile: { type: 'positional', required: false, description: 'Profile name' },
  },
  run({ args }) {
    const profiles = args.profile
      ? [resolveWorkspaceProfile(args.profile)]
      : listWorkspaceProfiles()

    for (const profile of profiles) {
      const hasSession = tmuxHas(profile.tmuxSession)
      const pid = listenPid(profile.appPort)
      const state = hasSession && pid ? pc.green('running') : pc.yellow('stopped')
      console.log(
        `  ${pc.bold(profile.displayName)} ${state} ${pc.dim(`session=${profile.tmuxSession} port=${profile.appPort}${pid ? ` pid=${pid}` : ''}`)}`,
      )
    }
  },
})

const start = defineCommand({
  meta: { name: 'start', description: 'Start a workspace profile in tmux' },
  args: {
    profile: { type: 'positional', required: false, description: 'Profile name' },
    restart: { type: 'boolean', description: 'Restart if already running' },
  },
  run({ args }) {
    const profile = resolveWorkspaceProfile(args.profile)
    if (tmuxHas(profile.tmuxSession)) {
      if (!args.restart) {
        console.log(`  ${profile.displayName} already has tmux session ${pc.bold(profile.tmuxSession)}.`)
        console.log(`  Use ${pc.cyan(`nyx workspace start ${profile.id} --restart`)} to recreate it.`)
        return
      }
      run('tmux', ['kill-session', '-t', profile.tmuxSession])
    }

    const command = buildWorkspaceStartCommand(profile)
    run('tmux', [
      'new-session',
      '-d',
      '-s',
      profile.tmuxSession,
      command,
    ])
    console.log(`  ${pc.green('Started')} ${profile.displayName}`)
    console.log(`  ${pc.dim('Local:')} http://127.0.0.1:${profile.appPort}/`)
  },
})

const stop = defineCommand({
  meta: { name: 'stop', description: 'Stop a workspace profile tmux session' },
  args: {
    profile: { type: 'positional', required: false, description: 'Profile name' },
  },
  run({ args }) {
    const profile = resolveWorkspaceProfile(args.profile)
    if (!tmuxHas(profile.tmuxSession)) {
      console.log(`  ${profile.displayName} is not running.`)
      return
    }
    run('tmux', ['kill-session', '-t', profile.tmuxSession])
    console.log(`  ${pc.green('Stopped')} ${profile.displayName}`)
  },
})

const command = defineCommand({
  meta: { name: 'command', description: 'Print the launch command for a workspace profile' },
  args: {
    profile: { type: 'positional', required: false, description: 'Profile name' },
  },
  run({ args }) {
    const profile = resolveWorkspaceProfile(args.profile)
    console.log(buildWorkspaceStartCommand(profile))
  },
})

const doctor = defineCommand({
  meta: { name: 'doctor', description: 'Check workspace prerequisites and profile health' },
  args: {
    profile: { type: 'positional', required: false, description: 'Profile name' },
  },
  run({ args }) {
    const profiles = args.profile
      ? [resolveWorkspaceProfile(args.profile)]
      : listWorkspaceProfiles()

    const tmuxReady = hasBinary('tmux')
    const lsofReady = hasBinary('lsof')

    console.log(`  tmux ${tmuxReady ? pc.green('ok') : pc.red('missing')}`)
    console.log(`  lsof ${lsofReady ? pc.green('ok') : pc.red('missing')}`)

    for (const profile of profiles) {
      const hasSession = tmuxReady ? tmuxHas(profile.tmuxSession) : false
      const pid = lsofReady ? listenPid(profile.appPort) : null
      const state = hasSession && pid ? pc.green('healthy') : pc.yellow('needs_attention')
      console.log(
        `  ${pc.bold(profile.displayName)} ${state} ${pc.dim(`session=${profile.tmuxSession} port=${profile.appPort}${pid ? ` pid=${pid}` : ''}`)}`,
      )
      if (!hasSession) {
        console.log(`    Start it with ${pc.cyan(`nyx workspace start ${profile.id}`)}`)
      }
    }
  },
})

const scaffold = defineCommand({
  meta: { name: 'scaffold', description: 'Create a NyxHive instance workspace scaffold' },
  args: {
    kind: { type: 'positional', required: true, description: 'Scaffold kind: astra' },
    target: {
      type: 'positional',
      required: false,
      description: 'Target directory',
    },
    register: {
      type: 'boolean',
      description: 'Register the workspace in ~/.nyxhive/workspaces.toml',
      default: true,
    },
  },
  run({ args }) {
    if (args.kind !== 'astra') {
      throw new Error(`Unknown workspace scaffold: ${args.kind}`)
    }

    const home = process.env.HOME ?? '/home/user'
    const targetRoot = resolve(args.target || `${home}/dev/personal/astra-trading`)
    const engine = getCurrentEngineIdentity()
    const result = scaffoldAstraTradingInstance({
      targetRoot,
      engineRoot: engine.path,
      engineCommit: engine.commit,
    })

    if (args.register) {
      const registryPath = workspaceRegistryPath()
      const registry = loadWorkspaceRegistry(registryPath)
      saveWorkspaceRegistry(registryPath, {
        workspaces: [
          ...registry.workspaces.filter((workspace) => workspace.id !== 'astra-trading'),
          { id: 'astra-trading', path: targetRoot },
        ],
      })
      console.log(`  ${pc.green('Registered')} astra-trading in ${registryPath}`)
    }

    console.log(`  ${pc.green('Created')} Astra Trading instance at ${result.root}`)
    console.log(`  ${pc.dim('Files:')} ${result.files.length}`)
  },
})

export default defineCommand({
  meta: { name: 'workspace', description: 'Manage Nyx Workspace profiles' },
  subCommands: { list, status, start, stop, command, doctor, scaffold },
})
