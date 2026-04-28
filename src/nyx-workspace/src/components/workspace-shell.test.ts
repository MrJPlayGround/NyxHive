import { describe, expect, it } from 'vitest'
import {
  DESKTOP_SIDEBAR_BACKDROP_CLASS,
  buildActiveRuntimeSessionKeys,
} from './workspace-shell'

describe('workspace shell sidebar backdrop', () => {
  it('only spans the desktop sidebar width, not the full viewport', () => {
    expect(DESKTOP_SIDEBAR_BACKDROP_CLASS).toContain('w-[300px]')
    expect(DESKTOP_SIDEBAR_BACKDROP_CLASS).not.toContain('inset-0')
  })
})

describe('workspace shell active runtime sessions', () => {
  it('combines streaming and waiting session keys for global return affordances', () => {
    expect(
      Array.from(
        buildActiveRuntimeSessionKeys(
          'session-a\nsession-b',
          'session-b\n friendly-c ',
        ),
      ).sort(),
    ).toEqual(['friendly-c', 'session-a', 'session-b'])
  })
})
