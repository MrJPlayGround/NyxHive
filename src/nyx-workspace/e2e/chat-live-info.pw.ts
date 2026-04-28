import { chromium, type Browser, type Page } from 'playwright'

const DEFAULT_URL = 'http://127.0.0.1:3780/chat/new'
const WEB_RESEARCH_PROMPT =
  'Hi Nyx Can you do a web search? what was the latest patch notes on black desert online? resume that to me'

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

async function assistantMessages(page: Page): Promise<Array<{ text: string; links: string[] }>> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-chat-message-role="assistant"]')).map((element) => ({
      text: element.textContent || '',
      links: Array.from(element.querySelectorAll('a')).map((anchor) => anchor.getAttribute('href') || ''),
    })),
  )
}

function assertUsefulLiveInfoAnswer(message: { text: string; links: string[] }) {
  const combined = `${message.text}\n${message.links.join('\n')}`
  if (/\b(?:i['’]?ll|i\s+will|let\s+me|i['’]?m\s+doing)\b[\s\S]{0,260}\b(?:pull|look\s+up|live\s+lookup|search|research|fetch|check|verify)\b/i.test(combined)) {
    throw new Error(`Assistant finalized a promise-only answer instead of live info:\n${combined}`)
  }
  if (/\bcouldn['’]?t complete that request\b|\bno assistant response\b|\bproduced no assistant response\b/i.test(combined)) {
    throw new Error(`Assistant finalized an error instead of a grounded live-info answer:\n${combined}`)
  }
  if (!/black\s+desert|patch\s+notes|playblackdesert/i.test(combined)) {
    throw new Error(`Assistant answer was not about Black Desert patch notes:\n${combined}`)
  }
  if (!/https?:\/\//i.test(combined)) {
    throw new Error(`Assistant answer did not include a source link:\n${combined}`)
  }
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

export async function runChatLiveInfoSmoke(
  url = process.env.NYX_WORKSPACE_SMOKE_URL ?? DEFAULT_URL,
) {
  let browser: Browser | null = null
  const consoleErrors: string[] = []
  const failedRequests: string[] = []

  browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('requestfailed', (request) => {
      failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`)
    })

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await dismissTour(page)
    const composer = await findComposer(page)
    await composer.fill(WEB_RESEARCH_PROMPT)
    await composer.press('Enter')

    let sawLiveInfoProgress = false
    const started = Date.now()
    let finalAssistant: { text: string; links: string[] } | null = null
    while (Date.now() - started < 150_000) {
      const bodyText = await page.locator('body').innerText({ timeout: 2_000 })
      if (/Searching web|Found \d+ web result/i.test(bodyText)) {
        sawLiveInfoProgress = true
      }
      const messages = await assistantMessages(page)
      const candidate = messages[messages.length - 1]
      if (candidate && /black\s+desert|patch\s+notes|playblackdesert/i.test(candidate.text)) {
        finalAssistant = candidate
        break
      }
      await page.waitForTimeout(250)
    }

    if (!sawLiveInfoProgress) {
      throw new Error('Live-info smoke never showed Searching web / Found N web results progress')
    }
    if (!finalAssistant) {
      throw new Error('Timed out waiting for a Black Desert patch-note assistant answer')
    }
    assertUsefulLiveInfoAnswer(finalAssistant)

    const sessionKey = getSessionKeyFromUrl(page.url())
    if (!sessionKey || sessionKey === 'new') {
      throw new Error(`Expected /chat/new to resolve to a real session, got ${page.url()}`)
    }

    await page.waitForTimeout(10_000)
    await assertNoThinkingCard(page, '10s after live-info completion')
    await assertActiveRunEmpty(page, sessionKey)

    const deleteResult = await page.evaluate(async (key) => {
      const query = new URLSearchParams({ sessionKey: key, friendlyId: key })
      const res = await fetch(`/api/sessions?${query.toString()}`, { method: 'DELETE' })
      return { ok: res.ok, body: await res.json().catch(() => ({})) }
    }, sessionKey)
    if (!deleteResult.ok) {
      throw new Error(`Failed to delete live-info smoke session: ${JSON.stringify(deleteResult)}`)
    }

    if (consoleErrors.length > 0) {
      throw new Error(`Console errors during live-info smoke:\n${consoleErrors.join('\n')}`)
    }

    return {
      ok: true,
      sessionKey,
      sawLiveInfoProgress,
      finalAssistant: finalAssistant.text.slice(0, 500),
      links: finalAssistant.links,
      failedRequests,
    }
  } finally {
    await browser?.close()
  }
}

if (import.meta.main) {
  runChatLiveInfoSmoke()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}
