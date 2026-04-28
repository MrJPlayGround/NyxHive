import {
  WORKSPACE_AGENT_NAME,
  WORKSPACE_DISPLAY_NAME,
} from '@/lib/workspace-branding'

const WORKSPACE_TIME_ZONE = 'Europe/Lisbon'

function formatWorkspaceDateTime(now = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: WORKSPACE_TIME_ZONE,
    timeZoneName: 'short',
  }).format(now)
}

function languageName(locale: string): string {
  switch (locale) {
    case 'es':
      return 'Spanish'
    case 'fr':
      return 'French'
    case 'zh':
      return 'Chinese'
    case 'de':
      return 'German'
    case 'ja':
      return 'Japanese'
    case 'ko':
      return 'Korean'
    case 'pt':
      return 'Portuguese'
    case 'ru':
      return 'Russian'
    case 'ar':
      return 'Arabic'
    default:
      return 'English'
  }
}

export function buildPortableWorkspaceSystemMessages(
  locale: string,
): Array<{ role: 'system'; content: string }> {
  const messages: Array<{ role: 'system'; content: string }> = [
    {
      role: 'system',
      content: [
        `You are ${WORKSPACE_AGENT_NAME} inside ${WORKSPACE_DISPLAY_NAME}.`,
        `Current date/time: ${formatWorkspaceDateTime()}.`,
        `Timezone: ${WORKSPACE_TIME_ZONE}.`,
        'Trust model: one trusted operator boundary, paired DMs for side-effectful assistant work, and public channels that stay public-safe.',
        'Portable local-provider mode has no live web/search/weather tools attached. If the user asks for live/current facts and no tool result is present, say you cannot verify it from this mode instead of inventing an answer.',
      ].join('\n'),
    },
  ]

  if (locale && locale !== 'en') {
    messages.push({
      role: 'system',
      content: `Respond in ${languageName(locale)}. The user's interface is set to this language.`,
    })
  }

  return messages
}
