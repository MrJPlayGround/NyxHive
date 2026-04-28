import { chromium, type Browser, type Page } from 'playwright'

const DEFAULT_URL = 'http://127.0.0.1:3780/chat/new'
const SMOKE_PREFIX = 'ui smoke ok'

async function dismissTour(page: Page) {
  await page
    .getByText('Skip tour', { exact: true })
    .click({ timeout: 5_000 })
    .catch(() => {})
}

async function findComposer(page: Page) {
  const selectors = ['textarea', '[contenteditable="true"]']

  for (const selector of selectors) {
    const candidate = page.locator(selector).last()
    try {
      await candidate.waitFor({ state: 'visible', timeout: 15_000 })
      return candidate
    } catch {
      // Try next composer shape.
    }
  }

  const textbox = page.getByRole('textbox').last()
  await textbox.waitFor({ state: 'visible', timeout: 15_000 })
  return textbox
}

function getSessionKeyFromUrl(url: string): string {
  const parsed = new URL(url)
  const parts = parsed.pathname.split('/').filter(Boolean)
  const chatIndex = parts.indexOf('chat')
  return chatIndex >= 0 ? (parts[chatIndex + 1] ?? '') : ''
}

async function assertNoThinkingCard(page: Page, label: string) {
  const thinkingCards = await page
    .locator('.thinking-shimmer-bubble, [data-testid="thinking-card"]')
    .count()
  if (thinkingCards !== 0) {
    throw new Error(`Expected no thinking card ${label}, found ${thinkingCards}`)
  }
}

async function assertActiveRunEmpty(page: Page, sessionKey: string) {
  const activeRun = await page.evaluate(async (key) => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(key)}/active-run`)
    return res.json()
  }, sessionKey)
  if (activeRun?.ok !== true || activeRun?.run !== null) {
    throw new Error(`Expected empty active-run for ${sessionKey}: ${JSON.stringify(activeRun)}`)
  }
}

export async function runChatNewThinkingSmoke(
  url = process.env.NYX_WORKSPACE_SMOKE_URL ?? DEFAULT_URL,
) {
  let browser: Browser | null = null
  const consoleErrors: Array<string> = []
  const failedRequests: Array<string> = []

  browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('requestfailed', (request) => {
      failedRequests.push(
        `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`,
      )
    })

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await dismissTour(page)
    const expectedReply = `${SMOKE_PREFIX} ${Date.now()}`
    const composer = await findComposer(page)
    await composer.fill(`Reply exactly: ${expectedReply}.`)
    await composer.press('Enter')

    await page.waitForFunction(
      (text) =>
        (document.body.innerText.match(new RegExp(text, 'g')) ?? []).length >= 2,
      expectedReply,
      { timeout: 120_000 },
    )

    const sessionKey = getSessionKeyFromUrl(page.url())
    if (!sessionKey || sessionKey === 'new') {
      throw new Error(`Expected /chat/new to resolve to a real session, got ${page.url()}`)
    }

    await page.waitForTimeout(10_000)
    await assertNoThinkingCard(page, '10s after completion')
    await assertActiveRunEmpty(page, sessionKey)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await dismissTour(page)
    await page.waitForFunction(
      (text) => document.body.innerText.includes(text),
      expectedReply,
      { timeout: 30_000 },
    )
    await assertNoThinkingCard(page, 'after idle refresh')

    await page.waitForTimeout(50_000)
    await assertNoThinkingCard(page, '60s after completion')
    await assertActiveRunEmpty(page, sessionKey)

    const deleteResult = await page.evaluate(async (key) => {
      const query = new URLSearchParams({ sessionKey: key, friendlyId: key })
      const res = await fetch(`/api/sessions?${query.toString()}`, { method: 'DELETE' })
      return { ok: res.ok, body: await res.json().catch(() => ({})) }
    }, sessionKey)
    if (!deleteResult.ok) {
      throw new Error(`Failed to delete smoke session: ${JSON.stringify(deleteResult)}`)
    }

    await page.waitForTimeout(2_000)
    const sessionStillListed = await page.evaluate(async (key) => {
      const res = await fetch('/api/sessions')
      const body = await res.json()
      return Array.isArray(body.sessions)
        ? body.sessions.some((session: any) => session.key === key || session.friendlyId === key)
        : false
    }, sessionKey)
    if (sessionStillListed) {
      throw new Error(`Deleted session ${sessionKey} was resurrected in /api/sessions`)
    }

    const mobilePage = await context.newPage()
    await mobilePage.setViewportSize({ width: 390, height: 844 })
    await mobilePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await dismissTour(mobilePage)
    await findComposer(mobilePage)
    await mobilePage.close()

    if (consoleErrors.length > 0) {
      throw new Error(
        `Console errors during chat lifecycle smoke:\n${consoleErrors.join('\n')}`,
      )
    }

    return { ok: true, sessionKey, consoleErrors, failedRequests }
  } finally {
    await browser?.close()
  }
}

if (import.meta.main) {
  runChatNewThinkingSmoke()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2))
    })
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}
