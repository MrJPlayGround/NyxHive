import { Suspense, lazy } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { usePageTitle } from '@/hooks/use-page-title'

const ProfilesScreen = lazy(async () => {
  const module = await import('@/screens/profiles/profiles-screen')
  return { default: module.ProfilesScreen }
})

export const Route = createFileRoute('/profiles')({
  ssr: false,
  component: ProfilesRoute,
})

function ProfilesRoute() {
  usePageTitle('Profiles')

  return (
    <Suspense fallback={<div className="p-6 text-sm text-primary-500">Loading profiles...</div>}>
      <ProfilesScreen />
    </Suspense>
  )
}
