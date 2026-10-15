// Wave Q (WS2): who may do what with the element library (docs/WAVE-Q-CONTRACTS.md §2.2), every route against every
// kind of caller: the workspace owner, an admin, the item's author (a creator member), another creator member, a
// member who is not a creator (an outsider), a creator member who only views the place target (a viewer), a workspace
// guest (a board-only collaborator), a name-only guest and a stranger to the workspace. Each cell runs on fresh rows
// (made by carol when the cell asks for them), so an allowed write never changes what the next caller meets. The
// guard lists and the in-route checks are each proven alone elsewhere (guests/refusals.test.ts,
// domain-access/creation-matrix.test.ts); here the whole app answers.

import { LIBRARY_RATE_LIMITS } from '@draftroom/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from '../../helpers.ts'
import type { GuestClient } from '../guests/support.ts'
import {
  addThumb,
  answer,
  image,
  itemUrl,
  LIB,
  type LibWorld,
  libraryWorld,
  place,
  rect,
  saved,
  uploadTo,
} from './support.ts'

const CALLERS = ['owner', 'admin', 'carol', 'dave', 'pat', 'vic', 'gina', 'sam', 'erin'] as const
type Caller = (typeof CALLERS)[number]
type Expect = Record<Caller, string>

const GUEST = '403 GUEST_ACCOUNT_REQUIRED'
const STRANGER = '404 NOT_FOUND'
const NOT_MEMBER = '403 FORBIDDEN'
const MISSING = '404 NOT_FOUND'
const OUTSIDE = '403 CREATOR_REQUIRED'

const all = (ok: string): Expect => ({
  owner: ok,
  admin: ok,
  carol: ok,
  dave: ok,
  pat: ok,
  vic: ok,
  gina: NOT_MEMBER,
  sam: GUEST,
  erin: STRANGER,
})
/** Reads and marks: every member. */
const READ = all('200')
/** A write to the workspace library: creators. */
const CREATE_WS = (ok: string): Expect => ({ ...all(ok), pat: OUTSIDE })
/** A change to carol's workspace item or folder: its author, owners and admins. */
const EDIT_WS = (ok: string): Expect => ({
  ...all(ok),
  dave: '403 FORBIDDEN',
  vic: '403 FORBIDDEN',
  pat: OUTSIDE,
})
/** Carol's personal library: carol alone (the owner and admins too get the 404 of a missing item). */
const OWN = (ok: string): Expect => ({
  ...all(MISSING),
  carol: ok,
  gina: NOT_MEMBER,
  sam: GUEST,
  erin: STRANGER,
})

/** Fresh rows for one cell, made by carol when the cell asks for them. */
interface Fresh {
  item(): Promise<{ id: string; revision: number }>
  personal(): Promise<string>
  folder(): Promise<string>
  personalFolder(): Promise<string>
}

interface Row {
  name: string
  expect: Expect
  call(c: Client | GuestClient, f: Fresh, who: Caller): ReturnType<Client['req']>
}

let w: LibWorld
let imageItem: string
let imageVersion: string
let n = 0

beforeAll(async () => {
  w = await libraryWorld()
  const v = await uploadTo(w, w.carol, w.source, 'pic.png')
  await addThumb(w.api, v)
  imageItem = (await saved(w.carol, w.source, { elements: [image('i', v)] })).id
  imageVersion = v.versionId
})
afterAll(() => w.api.close())

async function newFolder(scope: 'workspace' | 'personal') {
  const res = await w.carol.req('POST', `${LIB}/folders`, { scope, name: `Folder ${++n}` })
  expect(res.statusCode, res.body).toBe(201)
  return (res.json() as { id: string }).id
}

let saves = 0
/** Carol's fixture saves stay under her save rate limit (it has its own test): a new window every 50. */
async function carolSaves() {
  if (++saves % 50 === 0) w.api.clock.advance(LIBRARY_RATE_LIMITS.save.windowMs)
}

const fresh = (): Fresh => ({
  item: async () => {
    await carolSaves()
    const s = await saved(w.carol, w.source)
    return { id: s.id, revision: s.revision }
  },
  personal: async () => {
    await carolSaves()
    return (await saved(w.carol, w.source, { scope: 'personal' })).id
  },
  folder: () => newFolder('workspace'),
  personalFolder: () => newFolder('personal'),
})

const deleted = async (id: string) => {
  expect((await w.carol.req('DELETE', itemUrl(id))).statusCode).toBe(204)
  return id
}

const importBody = (scope: string) => ({
  scope,
  fileName: 'kit.excalidrawlib',
  items: [{ name: 'A', elements: [rect('a')] }],
})
const saveBody = (scope: string) => ({ scope, name: 'X', sourceBoardId: w.source, elements: [rect('x')] })

const ROWS: Row[] = [
  { name: 'GET list (workspace)', expect: READ, call: (c) => c.req('GET', `${LIB}?scope=workspace`) },
  { name: 'GET list (personal)', expect: READ, call: (c) => c.req('GET', `${LIB}?scope=personal`) },
  {
    name: 'GET a workspace item',
    expect: READ,
    call: async (c, f) => c.req('GET', itemUrl((await f.item()).id)),
  },
  {
    name: "GET carol's personal item",
    expect: OWN('200'),
    call: async (c, f) => c.req('GET', itemUrl(await f.personal())),
  },
  {
    name: 'GET a thumb of a workspace item',
    expect: READ,
    call: (c) => c.req('GET', `${itemUrl(imageItem)}/files/${imageVersion}/thumb`),
  },
  {
    name: 'POST a save (workspace)',
    expect: CREATE_WS('201'),
    call: (c) => c.req('POST', `${LIB}/items`, saveBody('workspace')),
  },
  {
    name: 'POST a save (personal)',
    expect: all('201'),
    call: (c) => c.req('POST', `${LIB}/items`, saveBody('personal')),
  },
  {
    name: "PATCH carol's workspace item",
    expect: EDIT_WS('200'),
    call: async (c, f) => {
      const item = await f.item()
      return c.req('PATCH', itemUrl(item.id), { revision: item.revision, name: 'Renamed' })
    },
  },
  {
    name: "PATCH carol's personal item",
    expect: OWN('200'),
    call: async (c, f) => c.req('PATCH', itemUrl(await f.personal()), { revision: 1, name: 'Renamed' }),
  },
  {
    name: "DELETE carol's workspace item",
    expect: EDIT_WS('204'),
    call: async (c, f) => c.req('DELETE', itemUrl((await f.item()).id)),
  },
  {
    name: "DELETE carol's personal item",
    expect: OWN('204'),
    call: async (c, f) => c.req('DELETE', itemUrl(await f.personal())),
  },
  {
    name: "restore carol's workspace item",
    expect: EDIT_WS('200'),
    call: async (c, f) => c.req('POST', `${itemUrl(await deleted((await f.item()).id))}/restore`),
  },
  {
    name: "restore carol's personal item",
    expect: OWN('200'),
    call: async (c, f) => c.req('POST', `${itemUrl(await deleted(await f.personal()))}/restore`),
  },
  {
    name: 'POST an import (workspace)',
    expect: CREATE_WS('200'),
    call: (c) => c.req('POST', `${LIB}/import`, importBody('workspace')),
  },
  {
    name: 'POST an import (personal)',
    expect: READ,
    call: (c) => c.req('POST', `${LIB}/import`, importBody('personal')),
  },
  {
    name: 'GET folders (workspace)',
    expect: READ,
    call: (c) => c.req('GET', `${LIB}/folders?scope=workspace`),
  },
  {
    name: 'GET folders (personal)',
    expect: READ,
    call: (c) => c.req('GET', `${LIB}/folders?scope=personal`),
  },
  {
    name: 'POST a folder (workspace)',
    expect: CREATE_WS('201'),
    call: (c, _f, who) => c.req('POST', `${LIB}/folders`, { scope: 'workspace', name: `By ${who}` }),
  },
  {
    name: 'POST a folder (personal)',
    expect: all('201'),
    call: (c, _f, who) => c.req('POST', `${LIB}/folders`, { scope: 'personal', name: `By ${who}` }),
  },
  {
    name: "PATCH carol's workspace folder",
    expect: EDIT_WS('200'),
    call: async (c, f) => c.req('PATCH', `${LIB}/folders/${await f.folder()}`, { position: 3 }),
  },
  {
    name: "PATCH carol's personal folder",
    expect: OWN('200'),
    call: async (c, f) => c.req('PATCH', `${LIB}/folders/${await f.personalFolder()}`, { position: 3 }),
  },
  {
    name: "DELETE carol's workspace folder",
    expect: EDIT_WS('204'),
    call: async (c, f) => c.req('DELETE', `${LIB}/folders/${await f.folder()}`),
  },
  {
    name: "DELETE carol's personal folder",
    expect: OWN('204'),
    call: async (c, f) => c.req('DELETE', `${LIB}/folders/${await f.personalFolder()}`),
  },
  { name: 'GET marks', expect: READ, call: (c) => c.req('GET', `${LIB}/marks`) },
  {
    name: 'PUT a mark of a built-in',
    expect: READ,
    call: (c) => c.req('PUT', `${LIB}/marks`, { key: 'piece:decision', favourite: true }),
  },
  {
    name: 'PUT a mark of a workspace item',
    expect: READ,
    call: async (c, f) => c.req('PUT', `${LIB}/marks`, { key: `item:${(await f.item()).id}`, used: true }),
  },
  {
    name: "PUT a mark of carol's personal item",
    expect: OWN('200'),
    call: async (c, f) =>
      c.req('PUT', `${LIB}/marks`, { key: `item:${await f.personal()}`, favourite: true }),
  },
  {
    // vic only views his board; gina edits the target but is a workspace guest; sam edits her guest board; erin
    // cannot see the target at all
    name: 'place a workspace item on a board the caller can edit (vic: one he only views)',
    expect: { ...READ, vic: '403 FORBIDDEN' },
    call: async (c, f, who) =>
      place(c, who === 'vic' ? w.viewOnly : who === 'sam' ? w.guestBoard : w.target, (await f.item()).id),
  },
  {
    name: "place carol's personal item",
    expect: OWN('200'),
    call: async (c, f) => place(c, w.target, await f.personal()),
  },
]

describe('the library permission matrix', () => {
  it(`every route × every kind of caller (${ROWS.length} rows × ${CALLERS.length} callers)`, async () => {
    const clients: Record<Caller, Client | GuestClient> = {
      owner: w.owner,
      admin: w.admin,
      carol: w.carol,
      dave: w.dave,
      pat: w.pat,
      vic: w.vic,
      gina: w.gina,
      sam: w.sam,
      erin: w.erin,
    }
    const got: Record<string, Record<string, string>> = {}
    const want: Record<string, Record<string, string>> = {}
    for (const row of ROWS)
      for (const who of CALLERS) {
        const res = await row.call(clients[who], fresh(), who)
        got[row.name] = { ...got[row.name], [who]: answer(res) }
        want[row.name] = { ...want[row.name], [who]: row.expect[who] }
      }
    expect(got).toEqual(want)
    expect(Object.values(got).flatMap((r) => Object.keys(r))).toHaveLength(ROWS.length * CALLERS.length)
  }, 120_000)
})
