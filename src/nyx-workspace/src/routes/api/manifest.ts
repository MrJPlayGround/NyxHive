import { createFileRoute } from '@tanstack/react-router'
import { buildWorkspaceManifest } from '../../lib/workspace-branding'

export const Route = createFileRoute('/api/manifest')({
  server: {
    handlers: {
      GET: async () =>
        new Response(JSON.stringify(buildWorkspaceManifest()), {
          headers: {
            'Content-Type': 'application/manifest+json; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        }),
    },
  },
})
