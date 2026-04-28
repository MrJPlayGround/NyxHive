import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { requireJsonContentType } from '../../../server/rate-limit'
import { applyMarketplaceSkillDraft } from '../../../server/marketplace-skill-drafts'

export const Route = createFileRoute('/api/skills/apply')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        try {
          const body = (await request.json()) as Record<string, unknown>
          const result = applyMarketplaceSkillDraft(body)
          return json(result)
        } catch (error) {
          return json(
            {
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to apply marketplace skill',
            },
            { status: 400 },
          )
        }
      },
    },
  },
})
