// refreshAiStatus (actions.ts): answers can come back out of order (a menu open's re-read, then the
// `ai.settings` hint's re-read after the owner switched AI off). Only the latest question's answer may
// set what the web shows, so an older "on" never brings AI back after the newer "off".

import type { AiStatus } from '@draftroom/contracts'
import type { Editor } from 'tldraw'
import { describe, expect, it } from 'vitest'
import type { FeatureContext } from '../types.ts'
import { refreshAiStatus } from './actions.ts'
import { aiStatus, setAiCtx } from './runtime.ts'

const status = (on: boolean): AiStatus => ({
  enabled: on,
  reason: on ? null : 'board-off',
  canInsert: on,
  canSummarize: on,
  noticeAccepted: true,
  budget: null,
  settings: { board: on, workspaceDefault: true, on, canManageBoard: false, canManageWorkspace: false },
})

function deferred<T>() {
  let resolve: (v: T) => void = () => {}
  let reject: (e: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fakeEditor() {
  const editor = {} as Editor
  const answers: ReturnType<typeof deferred<AiStatus>>[] = []
  const ctx = {
    board: { id: 'b1' },
    api: {
      request: () => {
        const d = deferred<AiStatus>()
        answers.push(d)
        return d.promise
      },
    },
  } as unknown as FeatureContext
  setAiCtx(editor, ctx)
  return { editor, answers }
}

describe('refreshAiStatus', () => {
  it('an older answer that arrives last never overrides the newer one', async () => {
    const { editor, answers } = fakeEditor()
    const first = refreshAiStatus(editor) // asked while AI was still on
    const second = refreshAiStatus(editor) // asked after the owner switched it off
    answers[1]?.resolve(status(false))
    await second
    answers[0]?.resolve(status(true))
    await first
    expect(aiStatus(editor).get()?.enabled).toBe(false)
  })

  it('an older failure that arrives last does not hide AI the newer answer shows', async () => {
    const { editor, answers } = fakeEditor()
    const first = refreshAiStatus(editor)
    const second = refreshAiStatus(editor)
    answers[1]?.resolve(status(true))
    await second
    answers[0]?.reject(new Error('network'))
    await first
    expect(aiStatus(editor).get()?.enabled).toBe(true)
  })
})
