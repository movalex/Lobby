// WS1 (wave R): shared fixtures of the Miro import tests (views of the contracts' shapes).
import type { ImportBoardView, ImportJobView, ListMiroBoardsResponse } from '@draftroom/contracts'

export const W = 'wsp_0123456789abcdefghij'
export const IMP = 'imp_0123456789abcdefghij'
export const TOKEN = 'eyJtaXJvLnRva2VuIjoidGVzdCJ9_0123456789'
export const PROJECT = 'prj_0123456789abcdefghij'

export function boardView(over: Partial<ImportBoardView> = {}): ImportBoardView {
  return {
    id: 'imb_0123456789abcdefghij',
    sourceRef: 'uXjVOD1Ab2c=',
    title: 'Roadmap',
    status: 'running',
    progress: {
      phase: 'reading',
      items: { read: 1200, total: 2000 },
      files: { done: 0, failed: 0, total: null, bytes: 0 },
    },
    boardId: null,
    errorCode: null,
    summary: null,
    finishedAt: null,
    ...over,
  }
}

export function jobView(over: Partial<ImportJobView> = {}): ImportJobView {
  return {
    importId: IMP,
    workspaceId: W,
    projectId: null,
    source: 'miro',
    status: 'running',
    startedBy: { id: 'usr_alice0123456789', name: 'Alice' },
    createdAt: '2026-10-16T08:00:00.000Z',
    updatedAt: '2026-10-16T08:01:00.000Z',
    finishedAt: null,
    resumable: false,
    resumeNeedsToken: false,
    boards: [boardView()],
    ...over,
  }
}

export const SUMMARY: NonNullable<ImportBoardView['summary']> = {
  total: 2000,
  counts: { native: 1912, approximate: 60, placeholder: 28, failed: 0, skipped: 0 },
  byType: {
    sticky_note: { native: 1500 },
    connector: { native: 400, approximate: 60 },
    image: { placeholder: 28 },
    frame: { native: 12 },
  },
  notes: { 'color-substituted': 140, 'connector-curved': 60, 'file-host-refused': 28, 'brand-new-note': 2 },
  rowsOmitted: 0,
}

export function doneJob(): ImportJobView {
  return jobView({
    status: 'done',
    finishedAt: '2026-10-16T08:05:00.000Z',
    boards: [
      boardView({
        status: 'done',
        progress: {
          phase: 'finished',
          items: { read: 2000, total: 2000 },
          files: { done: 0, failed: 28, total: 28, bytes: 0 },
        },
        boardId: 'b-roadmap01',
        summary: SUMMARY,
        finishedAt: '2026-10-16T08:05:00.000Z',
      }),
    ],
  })
}

export const BOARDS: ListMiroBoardsResponse = {
  team: { name: 'DBC <b>Design</b>' },
  boards: [
    { id: 'uXjVOD1Ab2c=', name: 'Roadmap', modifiedAt: '2026-10-01T12:00:00Z', viewLink: null },
    { id: 'uXjVOD9Zz9z=', name: '<img src=x onerror=alert(1)>', modifiedAt: null, viewLink: null },
  ],
  total: 120,
  offset: 0,
}
