import { Suspense, lazy } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import BackendUnavailableState from '@/components/backend-unavailable-state'
import { usePageTitle } from '@/hooks/use-page-title'
import { getUnavailableReason } from '@/lib/feature-gates'
import { useFeatureAvailable } from '@/hooks/use-feature-available'

const JobsScreen = lazy(async () => {
  const module = await import('@/screens/jobs/jobs-screen')
  return { default: module.JobsScreen }
})

const searchSchema = z.object({
  agent: z.string().optional(),
})

export const Route = createFileRoute('/jobs')({
  ssr: false,
  validateSearch: searchSchema,
  component: function JobsRoute() {
    usePageTitle('Jobs')
    if (!useFeatureAvailable('jobs')) {
      return (
        <BackendUnavailableState
          feature="Jobs"
          description={getUnavailableReason('Jobs')}
        />
      )
    }
    return (
      <Suspense fallback={<div className="p-6 text-sm text-primary-500">Loading jobs...</div>}>
        <JobsScreen />
      </Suspense>
    )
  },
})
