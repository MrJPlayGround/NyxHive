import { describe, expect, test } from 'bun:test'

const allowedBareBearerFiles = new Set([
  'src/nyx-workspace/src/server/gateway-auth-headers.ts',
  'src/nyx-workspace/src/server/gateway-capabilities.test.ts',
  'src/nyx-workspace/src/server/workspace-gateway-proxy-auth.test.ts',
])

const bareBearerPatterns = [
  /Authorization:\s*`Bearer \$\{BEARER_TOKEN\}`/,
  /Authorization:\s*`Bearer \$\{apiToken\}`/,
  /headers\[['"]Authorization['"]\]\s*=\s*`Bearer \$\{BEARER_TOKEN\}`/,
  /headers\.set\(['"]Authorization['"],\s*`Bearer \$\{BEARER_TOKEN\}`\)/,
]

describe('workspace gateway proxy auth', () => {
  test('server-side gateway calls use the shared internal auth header helper', async () => {
    const globs = [
      new Bun.Glob('src/nyx-workspace/src/routes/api/**/*.ts'),
      new Bun.Glob('src/nyx-workspace/src/server/**/*.ts'),
      new Bun.Glob('src/nyx-workspace/vite.config.ts'),
    ]
    const offenders = []
    for (const glob of globs) {
      for (const file of glob.scanSync({ cwd: process.cwd() })) {
        if (allowedBareBearerFiles.has(file)) continue
        const source = await Bun.file(file).text()
        if (bareBearerPatterns.some((pattern) => pattern.test(source))) {
          offenders.push(file)
        }
      }
    }

    expect(offenders).toEqual([])
  })
})
