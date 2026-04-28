import { chromium, type Browser } from 'playwright'

const DEFAULT_ORIGIN = 'http://127.0.0.1:3780'
const ROUTES = [
  { path: '/chat/new', expect: 'Nyx Workspace' },
  { path: '/dashboard', expect: 'Dashboard' },
  { path: '/tasks', expect: 'Tasks' },
  { path: '/memory', expect: 'Agent Memory' },
  { path: '/skills', expect: 'Skills' },
  { path: '/profiles', expect: 'Profiles' },
  { path: '/files', expect: 'Files' },
]

async function dismissTour(page: import('playwright').Page) {
  await page
    .getByText('Skip tour', { exact: true })
    .click({ timeout: 3_000 })
    .catch(() => {})
}

export async function runWorkspacePagesSmoke(
  origin = process.env.NYX_WORKSPACE_SMOKE_ORIGIN ?? DEFAULT_ORIGIN,
) {
  let browser: Browser | null = null
  const consoleErrors: Array<string> = []
  const results: Array<{ path: string; ok: boolean }> = []

  browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    for (const route of ROUTES) {
      const page = await context.newPage()
      page.on('console', (message) => {
        if (message.type() === 'error') {
          consoleErrors.push(`${route.path}: ${message.text()}`)
        }
      })
      await page.goto(`${origin}${route.path}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      })
      await dismissTour(page)
      await page.waitForFunction(
        (text) => document.body.innerText.includes(text),
        route.expect,
        { timeout: 30_000 },
      )
      results.push({ path: route.path, ok: true })
      await page.close()
    }

    const mobilePage = await context.newPage()
    await mobilePage.setViewportSize({ width: 390, height: 844 })
    await mobilePage.goto(`${origin}/chat/new`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
    await dismissTour(mobilePage)
    await mobilePage.locator('textarea').last().waitFor({ state: 'visible', timeout: 30_000 })
    await mobilePage.close()

    if (consoleErrors.length > 0) {
      throw new Error(`Console errors during workspace smoke:\n${consoleErrors.join('\n')}`)
    }

    return { ok: true, routes: results, consoleErrors }
  } finally {
    await browser?.close()
  }
}

if (import.meta.main) {
  runWorkspacePagesSmoke()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}
