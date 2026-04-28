import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const WORKSPACE_STORAGE_KEY = 'nyx-workspace-v1'
const LEGACY_WORKSPACE_STORAGE_KEY = 'hermes-workspace-v1'

type WorkspaceState = {
  sidebarCollapsed: boolean
  fileExplorerCollapsed: boolean
  chatFocusMode: boolean
  /** Currently active sub-page route (e.g. '/skills', '/channels') — null means chat-only */
  activeSubPage: string | null
  /** Chat panel visible alongside non-chat routes */
  chatPanelOpen: boolean
  /** Session key for the chat panel (defaults to 'main') */
  chatPanelSessionKey: string
  /** Mobile keyboard / composer focus — hides tab bar */
  mobileKeyboardOpen: boolean
  mobileKeyboardInset: number
  mobileComposerFocused: boolean
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  toggleFileExplorer: () => void
  setFileExplorerCollapsed: (collapsed: boolean) => void
  toggleChatFocusMode: () => void
  setChatFocusMode: (enabled: boolean) => void
  setActiveSubPage: (page: string | null) => void
  toggleChatPanel: () => void
  setChatPanelOpen: (open: boolean) => void
  setChatPanelSessionKey: (key: string) => void
  setMobileKeyboardOpen: (open: boolean) => void
  setMobileKeyboardInset: (inset: number) => void
  setMobileComposerFocused: (focused: boolean) => void
}

function migrateWorkspaceStorageKey(): void {
  if (typeof window === 'undefined') return
  try {
    const current = window.localStorage.getItem(WORKSPACE_STORAGE_KEY)
    const legacy = window.localStorage.getItem(LEGACY_WORKSPACE_STORAGE_KEY)
    if (!current && legacy) {
      window.localStorage.setItem(WORKSPACE_STORAGE_KEY, legacy)
    }
    if (legacy) {
      window.localStorage.removeItem(LEGACY_WORKSPACE_STORAGE_KEY)
    }
  } catch {
    // Ignore storage failures in private browsing.
  }
}

migrateWorkspaceStorageKey()

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      fileExplorerCollapsed: true,
      chatFocusMode: false,
      activeSubPage: null,
      chatPanelOpen: false,
      chatPanelSessionKey: 'main',
      mobileKeyboardOpen: false,
      mobileKeyboardInset: 0,
      mobileComposerFocused: false,
      toggleSidebar: () =>
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      toggleFileExplorer: () =>
        set((s) => ({ fileExplorerCollapsed: !s.fileExplorerCollapsed })),
      setFileExplorerCollapsed: (collapsed) =>
        set({ fileExplorerCollapsed: collapsed }),
      toggleChatFocusMode: () =>
        set((s) => ({ chatFocusMode: !s.chatFocusMode })),
      setChatFocusMode: (enabled) => set({ chatFocusMode: enabled }),
      setActiveSubPage: (page) => set({ activeSubPage: page }),
      toggleChatPanel: () => set((s) => ({ chatPanelOpen: !s.chatPanelOpen })),
      setChatPanelOpen: (open) => set({ chatPanelOpen: open }),
      setMobileKeyboardOpen: (open) => set({ mobileKeyboardOpen: open }),
      setMobileKeyboardInset: (inset) => set({ mobileKeyboardInset: inset }),
      setMobileComposerFocused: (focused) =>
        set({ mobileComposerFocused: focused }),
      setChatPanelSessionKey: (key) => set({ chatPanelSessionKey: key }),
    }),
    {
      name: WORKSPACE_STORAGE_KEY,
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        fileExplorerCollapsed: state.fileExplorerCollapsed,
        chatPanelOpen: state.chatPanelOpen,
        chatPanelSessionKey: state.chatPanelSessionKey,
      }),
    },
  ),
)
