export const CHAT_OPEN_MESSAGE_SEARCH_EVENT = 'nyx:chat-open-message-search'

export const CHAT_RUN_COMMAND_EVENT = 'nyx:chat-run-command'

export const CHAT_PENDING_COMMAND_STORAGE_KEY = 'nyx.pending-chat-command'

export type ChatRunCommandDetail = {
  command: string
}

export const CHAT_OPEN_SETTINGS_EVENT = 'nyx:chat-open-settings'

export type ChatOpenSettingsDetail = {
  section: 'nyx' | 'appearance'
}
