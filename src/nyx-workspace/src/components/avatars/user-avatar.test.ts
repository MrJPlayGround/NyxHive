import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_USER_AVATAR_SRC } from './user-avatar'

describe('user avatar', () => {
  test('uses User logo as the default avatar asset', () => {
    expect(DEFAULT_USER_AVATAR_SRC).toBe('/jay-avatar.png')
    expect(
      existsSync(join(process.cwd(), 'src/nyx-workspace/public/jay-avatar.png')),
    ).toBe(true)
  })
})
