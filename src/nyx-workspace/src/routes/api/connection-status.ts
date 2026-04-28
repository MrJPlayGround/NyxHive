/**
 * Connection status endpoint — returns a summary of portable chat readiness
 * plus whether Nyx gateway enhancements are available.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createFileRoute } from '@tanstack/react-router'
import YAML from 'yaml'
import {
  NYX_API_URL,
  ensureGatewayProbed,
  getChatMode,
} from '../../server/gateway-capabilities'
import { isAuthenticated } from '../../server/auth-middleware'
import { getNyxWorkspaceHome } from '../../server/workspace-home'

const CONFIG_PATH = path.join(getNyxWorkspaceHome(), 'config.yaml')

function readActiveModel(): string {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const config = (YAML.parse(raw) as Record<string, unknown>) || {}
    const modelField = config.model
    if (typeof modelField === 'string') return modelField
    if (modelField && typeof modelField === 'object') {
      const obj = modelField as Record<string, unknown>
      return (obj.default as string) || ''
    }
  } catch {
    // config missing or unreadable
  }
  return ''
}

type ConnectionStatus = {
  status: 'connected' | 'enhanced' | 'partial' | 'disconnected'
  label: 'Connected' | 'Enhanced' | 'Partial' | 'Disconnected'
  detail: string
  health: boolean
  chatReady: boolean
  modelConfigured: boolean
  activeModel: string
  chatMode: 'enhanced-nyx' | 'portable' | 'disconnected'
  capabilities: Record<string, boolean>
  nyxApiUrl: string
}

export const Route = createFileRoute('/api/connection-status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const authResult = isAuthenticated(request)
        if (authResult !== true) return authResult as unknown as Response

        const caps = await ensureGatewayProbed()
        const activeModel = readActiveModel()
        const modelConfigured = Boolean(activeModel)

        const chatReady = caps.chatCompletions || caps.sessions
        const enhancedReady =
          chatReady &&
          caps.sessions &&
          caps.skills &&
          caps.memory &&
          caps.config

        let status: ConnectionStatus['status']
        let label: ConnectionStatus['label']
        let detail: string

        if (!caps.health && !chatReady) {
          status = 'disconnected'
          label = 'Disconnected'
          detail = 'No compatible backend detected.'
        } else if (enhancedReady) {
          status = 'enhanced'
          label = 'Enhanced'
          detail = modelConfigured
            ? 'Core chat works and Nyx gateway APIs are available.'
            : 'Nyx gateway APIs are available. Choose a model to start chatting.'
        } else if (chatReady && modelConfigured) {
          status = 'connected'
          label = 'Connected'
          detail = 'Core chat is ready on this backend.'
        } else {
          status = 'partial'
          label = 'Partial'
          if (!chatReady) {
            detail = 'Backend reachable, but chat API is not ready yet.'
          } else if (!modelConfigured) {
            detail =
              'Backend connected. Choose a provider and model to test chat.'
          } else {
            detail =
              'Core chat works. Enhanced Nyx gateway APIs are optional and unlock automatically when available.'
          }
        }

        const body: ConnectionStatus = {
          status,
          label,
          detail,
          health: caps.health,
          chatReady,
          modelConfigured,
          activeModel,
          chatMode: getChatMode(),
          capabilities: {
            health: caps.health,
            chatCompletions: caps.chatCompletions,
            models: caps.models,
            streaming: caps.streaming,
            sessions: caps.sessions,
            skills: caps.skills,
            memory: caps.memory,
            config: caps.config,
            jobs: caps.jobs,
          },
          nyxApiUrl: NYX_API_URL,
        }

        return Response.json(body)
      },
    },
  },
})
