import { Suspense, lazy } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { usePageTitle } from '@/hooks/use-page-title'

const DashboardScreen = lazy(async () => {
  const module = await import('@/screens/dashboard/dashboard-screen')
  return { default: module.DashboardScreen }
})

export const Route = createFileRoute('/dashboard')({
  ssr: false,
  component: DashboardRoute,
})

function DashboardRoute() {
  usePageTitle('Dashboard')
  return (
    <Suspense fallback={<div className="p-6 text-sm text-primary-500">Loading dashboard...</div>}>
      <DashboardScreen />
    </Suspense>
  )
}
