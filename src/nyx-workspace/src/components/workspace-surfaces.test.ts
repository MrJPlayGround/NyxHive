import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

describe('workspace operational surfaces', () => {
  test('skills route uses the workspace skills browser without stale gateway gating', () => {
    const skillsRoute = source('src/nyx-workspace/src/routes/skills.tsx')

    expect(skillsRoute).toContain('SkillsScreen')
    expect(skillsRoute).not.toContain('BackendUnavailableState')
    expect(skillsRoute).not.toContain("useFeatureAvailable('skills')")
    expect(skillsRoute).not.toContain('getUnavailableReason')
  })

  test('control inspector is mounted globally and exposed from sidebar navigation', () => {
    const shell = source('src/nyx-workspace/src/components/workspace-shell.tsx')
    const chat = source('src/nyx-workspace/src/screens/chat/chat-screen.tsx')
    const sidebar = source(
      'src/nyx-workspace/src/screens/chat/components/chat-sidebar.tsx',
    )

    expect(shell).toContain('InspectorPanel')
    expect(chat).not.toContain('<InspectorPanel />')
    expect(sidebar).toContain('Control')
    expect(sidebar).toContain('useInspectorStore')
  })

  test('operations route is first-class and linked from the sidebar', () => {
    const operationsRoute = source('src/nyx-workspace/src/routes/operations.tsx')
    const operationsScreen = source(
      'src/nyx-workspace/src/screens/operations/operations-screen.tsx',
    )
    const sidebar = source(
      'src/nyx-workspace/src/screens/chat/components/chat-sidebar.tsx',
    )

    expect(operationsRoute).toContain('OperationsScreen')
    expect(operationsScreen).toContain('MissionLauncher')
    expect(operationsScreen).toContain('RunLedger')
    expect(operationsScreen).toContain('CrewOpsPanel')
    expect(sidebar).toContain("to: '/operations'")
    expect(sidebar).toContain('Operations')
  })

  test('operations is reachable from mobile navigation and gets a proper mobile page title', () => {
    const workspaceShell = source(
      'src/nyx-workspace/src/components/workspace-shell.tsx',
    )
    const mobileMenu = source(
      'src/nyx-workspace/src/components/mobile-hamburger-menu.tsx',
    )

    expect(mobileMenu).toContain("to: '/operations'")
    expect(mobileMenu).toContain("label: 'Operations'")
    expect(workspaceShell).toContain("if (pathname.startsWith('/operations')) return 'Operations'")
  })

  test('operations launch surface passes launcher profiles instead of an undefined crew prop', () => {
    const operationsScreen = source(
      'src/nyx-workspace/src/screens/operations/operations-screen.tsx',
    )

    expect(operationsScreen).toContain('const launcherProfiles = crew.map(')
    expect(operationsScreen).toContain('<MissionLauncher')
    expect(operationsScreen).toContain('profiles={launcherProfiles}')
  })

  test('operations surfaces use workspace theme cards instead of hard-coded white panels', () => {
    const files = [
      source('src/nyx-workspace/src/screens/operations/operations-screen.tsx'),
      source(
        'src/nyx-workspace/src/screens/operations/components/mission-launcher.tsx',
      ),
      source(
        'src/nyx-workspace/src/screens/operations/components/crew-ops-panel.tsx',
      ),
      source(
        'src/nyx-workspace/src/screens/operations/components/mission-list.tsx',
      ),
      source(
        'src/nyx-workspace/src/screens/operations/components/run-ledger.tsx',
      ),
    ]

    for (const file of files) {
      expect(file).toContain('var(--theme-card)')
      expect(file).not.toContain('bg-white/90')
    }
  })
})
