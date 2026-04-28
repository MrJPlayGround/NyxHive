import { createFileRoute } from '@tanstack/react-router'
import { WORKSPACE_AGENT_NAME } from '../../lib/workspace-branding'

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function initial(value: string): string {
  return (value.trim()[0] || 'N').toUpperCase()
}

export const Route = createFileRoute('/api/manifest-icon/svg')({
  server: {
    handlers: {
      GET: async () => {
        const letter = escapeXml(initial(WORKSPACE_AGENT_NAME))
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#111827"/>
      <stop offset="52%" stop-color="#312e81"/>
      <stop offset="100%" stop-color="#e8b84a"/>
    </linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="18" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <circle cx="256" cy="256" r="172" fill="rgba(255,255,255,0.08)" stroke="rgba(255,255,255,0.24)" stroke-width="3"/>
  <text x="256" y="314" text-anchor="middle" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="196" font-weight="760" fill="#fff7d6" filter="url(#glow)">${letter}</text>
</svg>`
        return new Response(svg, {
          headers: {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        })
      },
    },
  },
})
