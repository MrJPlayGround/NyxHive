import { defineCommand } from 'citty'
import pc from 'picocolors'
import { listWorkspaceProfiles } from '../lib/workspace-profiles.js'
import {
  compareEngineLock,
  getCurrentEngineIdentity,
  writeEngineLock,
  type EngineUpdateStatus,
} from '../../workspaces/updates.js'

export function formatEngineUpdateStatus(status: EngineUpdateStatus): string {
  const label = status.workspaceId ?? 'workspace'
  const state =
    status.state === 'current'
      ? pc.green(status.state)
      : status.state === 'update_available'
        ? pc.yellow(status.state)
        : pc.red(status.state)
  const locked = status.locked?.engine.commit
  const current = status.current.commit
  const commits = locked ? `${locked.slice(0, 8)} -> ${current.slice(0, 8)}` : current.slice(0, 8)
  return `${label} ${state} ${pc.dim(commits)} ${status.reason}`
}

const check = defineCommand({
  meta: { name: 'check', description: 'Check NyxHive engine updates for workspaces' },
  args: {
    workspace: { type: 'positional', required: false, description: 'Workspace id' },
  },
  run({ args }) {
    const current = getCurrentEngineIdentity()
    const profiles = listWorkspaceProfiles()
      .filter((profile) => !args.workspace || profile.id === args.workspace)

    for (const profile of profiles) {
      console.log(formatEngineUpdateStatus(
        compareEngineLock(profile.workspaceRoot, current, profile.id),
      ))
    }
  },
})

const ack = defineCommand({
  meta: { name: 'ack', description: 'Record current NyxHive engine identity for a workspace' },
  args: {
    workspace: { type: 'positional', required: true, description: 'Workspace id' },
  },
  run({ args }) {
    const current = getCurrentEngineIdentity()
    const profile = listWorkspaceProfiles().find((entry) => entry.id === args.workspace)
    if (!profile) throw new Error(`Unknown workspace: ${args.workspace}`)

    writeEngineLock(profile.workspaceRoot, current)
    console.log(`${profile.id} ${pc.green('acknowledged')} ${pc.dim(current.commit.slice(0, 8))}`)
  },
})

export default defineCommand({
  meta: { name: 'updates', description: 'Check and acknowledge NyxHive engine updates' },
  subCommands: { check, ack },
})
