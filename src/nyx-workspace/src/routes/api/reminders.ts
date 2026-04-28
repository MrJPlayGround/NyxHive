import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  completeReminder,
  createReminder,
  listReminders,
} from '../../server/tasks-store'

export const Route = createFileRoute('/api/reminders')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const url = new URL(request.url)
        const includeDone = url.searchParams.get('include_done') === 'true'
        return json({ ok: true, reminders: listReminders(includeDone) })
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const body = (await request.json()) as Record<string, unknown>
          if (typeof body.title !== 'string' || body.title.trim().length === 0) {
            return json({ ok: false, error: 'title is required' }, { status: 400 })
          }
          const remindAt = body.remindAt ?? body.remind_at ?? body.due_date
          if (typeof remindAt !== 'string' || remindAt.trim().length === 0) {
            return json({ ok: false, error: 'remindAt is required' }, { status: 400 })
          }
          const reminder = createReminder({
            title: body.title.trim(),
            remindAt,
            timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
            description:
              typeof body.description === 'string' ? body.description : undefined,
            createdBy:
              typeof body.created_by === 'string' ? body.created_by : 'nyx',
          })
          return json({ ok: true, reminder }, { status: 201 })
        } catch (error) {
          return json(
            { ok: false, error: error instanceof Error ? error.message : 'Invalid request body' },
            { status: 400 },
          )
        }
      },
      PATCH: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
        const id = typeof body.id === 'string' ? body.id.trim() : ''
        if (!id) return json({ ok: false, error: 'id is required' }, { status: 400 })
        const reminder = completeReminder(id)
        if (!reminder) {
          return json({ ok: false, error: 'Reminder not found' }, { status: 404 })
        }
        return json({ ok: true, reminder })
      },
    },
  },
})
