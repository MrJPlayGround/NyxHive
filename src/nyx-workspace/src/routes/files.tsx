import { Suspense, lazy } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { usePageTitle } from '@/hooks/use-page-title'

const FilesScreen = lazy(async () => {
  const module = await import('@/screens/files/files-screen')
  return { default: module.FilesScreen }
})

export const Route = createFileRoute('/files')({
  ssr: false,
  component: FilesRoute,
  errorComponent: function FilesError({ error }) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center bg-primary-50">
        <h2 className="text-xl font-semibold text-primary-900 mb-3">
          Failed to Load Files
        </h2>
        <p className="text-sm text-primary-600 mb-4 max-w-md">
          {error instanceof Error
            ? error.message
            : 'An unexpected error occurred'}
        </p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 bg-accent-500 text-white rounded-lg hover:bg-accent-600 transition-colors"
        >
          Reload Page
        </button>
      </div>
    )
  },
  pendingComponent: function FilesPending() {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-accent-500 border-r-transparent mb-3" />
          <p className="text-sm text-primary-500">Loading file explorer...</p>
        </div>
      </div>
    )
  },
})

function FilesRoute() {
  usePageTitle('Files')
  return (
    <Suspense fallback={<div className="p-6 text-sm text-primary-500">Loading files...</div>}>
      <FilesScreen />
    </Suspense>
  )
}
