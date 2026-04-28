import { Suspense, lazy } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { usePageTitle } from '@/hooks/use-page-title'

const OperationsScreen = lazy(async () => {
  const module = await import('@/screens/operations/operations-screen')
  return { default: module.OperationsScreen }
})

export const Route = createFileRoute('/operations')({
  ssr: false,
  component: function OperationsRoute() {
    usePageTitle('Operations')
    return (
      <Suspense fallback={<div className="p-6 text-sm text-primary-500">Loading operations...</div>}>
        <OperationsScreen />
      </Suspense>
    )
  },
})
