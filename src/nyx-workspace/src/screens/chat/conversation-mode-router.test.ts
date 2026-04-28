import { describe, expect, test } from 'bun:test'

import {
  getConversationModePosture,
  resolveAutoConversationMode,
} from './conversation-mode-router'

describe('resolveAutoConversationMode', () => {
  test('keeps lightweight conversation fast', () => {
    expect(resolveAutoConversationMode({ message: 'thanks nyx' })).toEqual({
      mode: 'quick',
      reasoning: 'low',
      confidence: 'high',
      reason: 'lightweight conversational turn',
    })

    expect(
      resolveAutoConversationMode({ message: 'BDO cooking boxes worth doing?' }),
    ).toMatchObject({
      mode: 'quick',
      reasoning: 'low',
    })
  })

  test('routes bounded tool tasks without waking build mode', () => {
    expect(
      resolveAutoConversationMode({ message: "look up today's weather" }),
    ).toMatchObject({
      mode: 'task',
      reasoning: 'low',
      confidence: 'high',
    })

    expect(
      resolveAutoConversationMode({ message: 'summarize this page for me' }),
    ).toMatchObject({
      mode: 'task',
      reasoning: 'medium',
    })

    expect(
      resolveAutoConversationMode({ message: 'can you check my emails?' }),
    ).toMatchObject({
      mode: 'task',
      reasoning: 'low',
    })

    expect(resolveAutoConversationMode({ message: 'run date for me' }))
      .toMatchObject({
        mode: 'task',
        reasoning: 'low',
      })
  })

  test('routes implementation and repo language to build mode', () => {
    expect(
      resolveAutoConversationMode({ message: 'fix this bug and commit' }),
    ).toMatchObject({
      mode: 'build',
      reasoning: 'medium',
      confidence: 'high',
    })
  })

  test('routes planning and architecture to deep mode', () => {
    expect(
      resolveAutoConversationMode({ message: 'plan the mode router rollout' }),
    ).toMatchObject({
      mode: 'deep',
      reasoning: 'high',
      confidence: 'high',
    })

    expect(
      resolveAutoConversationMode({
        message: 'pressure-test this architecture before we move',
      }),
    ).toMatchObject({
      mode: 'deep',
        reasoning: 'high',
      })

    expect(
      resolveAutoConversationMode({
        message: "let's plan this out, how would we do it?",
      }),
    ).toMatchObject({
      mode: 'deep',
      reasoning: 'high',
    })
  })

  test('honors explicit mode intent inside auto', () => {
    expect(resolveAutoConversationMode({ message: 'quick answer only' }))
      .toMatchObject({
        mode: 'quick',
        reasoning: 'low',
      })

    expect(resolveAutoConversationMode({ message: 'use build mode for this' }))
      .toMatchObject({
        mode: 'build',
        reasoning: 'medium',
      })
  })

  test('does not treat reflective file mentions as implementation requests', () => {
    expect(
      resolveAutoConversationMode({
        message:
          'what do you think of src/queue/processor.ts being the heart of it?',
      }),
    ).toMatchObject({
      mode: 'quick',
      reasoning: 'low',
    })
  })

  test('describes the semantic runtime promise of each explicit mode', () => {
    expect(getConversationModePosture('quick')).toMatchObject({
      runtimePosture: 'conversation',
    })
    expect(getConversationModePosture('task')).toMatchObject({
      runtimePosture: 'investigation',
    })
    expect(getConversationModePosture('build')).toMatchObject({
      runtimePosture: 'execution',
      detail: 'Execution posture with verification expectations.',
    })
    expect(getConversationModePosture('deep')).toMatchObject({
      runtimePosture: 'reflection',
    })
  })
})
