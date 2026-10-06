// Shared by the wave J pre-deploy review tests (internal-only-move.test.ts, internal-only-copies.test.ts).

import { INTERNAL_ONLY_CODE, INTERNAL_ONLY_MESSAGES, Me } from '@draftroom/contracts'
import type { LightMyRequestResponse } from 'fastify'
import { expect } from 'vitest'
import type { Client, TestApi } from '../../helpers.ts'

const code = (res: LightMyRequestResponse) => (res.json() as { error?: { code?: string } }).error?.code
const message = (res: LightMyRequestResponse) =>
  (res.json() as { error?: { message?: string } }).error?.message

/** 409 INTERNAL_ONLY with that scope's words. */
export const refused = (res: LightMyRequestResponse, scope: 'workspace' | 'project') => {
  expect(res.statusCode, res.body).toBe(409)
  expect(code(res)).toBe(INTERNAL_ONLY_CODE)
  expect(message(res)).toBe(INTERNAL_ONLY_MESSAGES[scope])
}

export type Req = Pick<Client, 'req'>

export const newProject = async (c: Req, wid: string, name: string) => {
  const res = await c.req('POST', `/api/workspaces/${wid}/projects`, { name })
  expect(res.statusCode, res.body).toBe(201)
  return (res.json() as { id: string }).id
}
export const setProject = (c: Req, project: string, on: boolean) =>
  c.req('PUT', `/api/projects/${project}/internal-only`, { internalOnly: on })
export const move = (c: Req, board: string, projectId: string | null) =>
  c.req('PATCH', `/api/boards/${board}`, { projectId })
export const visibility = (c: Req, board: string, to: string) =>
  c.req('PATCH', `/api/boards/${board}`, { visibility: to })
export const projectOf = async (api: TestApi, board: string) =>
  (await api.db.one<{ project_id: string | null }>('SELECT project_id FROM boards WHERE id = $1', [board]))
    .project_id
export const visibilityOf = async (api: TestApi, board: string) =>
  (await api.db.one<{ visibility: string }>('SELECT visibility FROM boards WHERE id = $1', [board]))
    .visibility
export const grantsOf = async (api: TestApi, board: string) =>
  Object.fromEntries(
    (
      await api.db.query<{ user_id: string; role: string }>(
        'SELECT user_id, role FROM board_members WHERE board_id = $1',
        [board],
      )
    ).rows.map((r) => [r.user_id, r.role]),
  )
export const addMember = (api: TestApi, wid: string, userId: string, role: string) =>
  api.db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [wid, userId, role],
  )
export const grant = (api: TestApi, board: string, userId: string, role: string, by: string) =>
  api.db.query(
    `INSERT INTO board_members (board_id, user_id, role, added_by, created_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (board_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [board, userId, role, by],
  )

/** Open email sign-in (docs/OPEN-SIGNIN.md): everyone who signs in is a creator. */
export const OPEN_ENV = { DRAFTROOM_DEV_AUTH: '0', AUTH_PROVIDER: 'email', DRAFTROOM_OPEN_SIGNIN: '1' }

export async function emailLogin(api: TestApi, email: string, name: string) {
  const res = await api.anon('POST', '/api/auth/email/login', { email, name })
  expect(res.statusCode, res.body).toBe(200)
  const cookie = res.cookies.find((c) => c.name === 'dr_session')?.value ?? ''
  const me = Me.parse(res.json())
  return {
    userId: me.user.id,
    req: (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: unknown) =>
      api.anon(method, url, body, { cookie: `dr_session=${cookie}` }),
  }
}

/** An internal-only project in the open sign-in's shared workspace (members cannot switch one on). */
export async function internalProjectIn(api: TestApi, workspaceId: string, name: string): Promise<string> {
  const id = `prj_${name
    .replace(/[^0-9A-Za-z]/g, '')
    .padEnd(20, 'X')
    .slice(0, 20)}`
  await api.db.query(
    'INSERT INTO projects (id, workspace_id, name, created_at, internal_only) VALUES ($1, $2, $3, now(), true)',
    [id, workspaceId, name],
  )
  return id
}
