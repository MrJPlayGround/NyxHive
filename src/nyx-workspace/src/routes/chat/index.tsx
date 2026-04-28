import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/chat/')({
  ssr: false,
  beforeLoad: () => {
    // Try to restore last active session from localStorage
    let lastSession = 'new'
    try {
      const stored =
        typeof window !== 'undefined'
          ? localStorage.getItem('nyx-last-session') ||
            localStorage.getItem('hermes-last-session')
          : null
      if (stored && stored !== 'main') {
        lastSession = stored
        if (typeof window !== 'undefined') {
          localStorage.setItem('nyx-last-session', stored)
          localStorage.removeItem('hermes-last-session')
        }
      }
    } catch {}
    throw redirect({
      to: '/chat/$sessionKey',
      params: { sessionKey: lastSession },
      replace: true,
    })
  },
  component: function ChatIndexRoute() {
    return null
  },
})
