import path from 'node:path'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { getNyxWorkspaceHome } from '../../server/workspace-home'

const NYX_HOME = getNyxWorkspaceHome()

export const Route = createFileRoute('/api/paths')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        return json({
          ok: true,
          nyxHome: NYX_HOME,
          memoryDir: path.join(NYX_HOME, 'memory'),
          memoriesDir: path.join(NYX_HOME, 'memory'),
          skillsDir: path.join(NYX_HOME, 'skills'),
          profilesDir: path.join(NYX_HOME, 'profiles'),
        })
      },
    },
  },
})
