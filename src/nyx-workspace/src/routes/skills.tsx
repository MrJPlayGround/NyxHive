import { Suspense, lazy } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { usePageTitle } from '@/hooks/use-page-title'

const SkillsScreen = lazy(async () => {
  const module = await import('@/screens/skills/skills-screen')
  return { default: module.SkillsScreen }
})

export const Route = createFileRoute('/skills')({
  ssr: false,
  component: SkillsRoute,
})

function SkillsRoute() {
  usePageTitle('Skills')
  return (
    <Suspense fallback={<div className="p-6 text-sm text-primary-500">Loading skills...</div>}>
      <SkillsScreen />
    </Suspense>
  )
}
