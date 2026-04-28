import { useEffect } from 'react'
import { WORKSPACE_DISPLAY_NAME } from '@/lib/workspace-branding'

/**
 * Sets document.title for the current page.
 * Usage: usePageTitle('Sessions') → "Sessions — <workspace>"
 */
export function usePageTitle(page: string) {
  useEffect(() => {
    document.title = page
      ? `${page} — ${WORKSPACE_DISPLAY_NAME}`
      : WORKSPACE_DISPLAY_NAME
    return () => {
      document.title = WORKSPACE_DISPLAY_NAME
    }
  }, [page])
}
