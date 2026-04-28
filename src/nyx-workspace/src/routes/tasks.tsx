import { Suspense, lazy } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { usePageTitle } from '@/hooks/use-page-title'

const TasksScreen = lazy(async () => {
  const module = await import('@/screens/tasks/tasks-screen')
  return { default: module.TasksScreen }
})

const searchSchema = z.object({
  assignee: z.string().optional(),
})

export const Route = createFileRoute('/tasks')({
  ssr: false,
  validateSearch: searchSchema,
  component: TasksRoute,
})

function TasksRoute() {
  usePageTitle('Tasks')
  return (
    <Suspense fallback={<div className="p-6 text-sm text-primary-500">Loading tasks...</div>}>
      <TasksScreen />
    </Suspense>
  )
}
