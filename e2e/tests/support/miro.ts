// The fake Miro of the r1-* specs (wave R, WS1): the shared fake (packages/miro-import fake-miro.ts: the REST API v2
// read paths over the fixture boards, in Miro's documented shapes, and a second origin for the signed downloads) on
// two fixed ports of this run, and the api env that points the import at it (DRAFTROOM_MIRO_TEST_ORIGINS, honoured
// only behind the local-dev guard). The browser never talks to it: the specs assert no request of the page leaves
// Lobby's own origins. Nothing here ever calls the real Miro.
import { type FakeMiro, startFakeMiro } from '../../../packages/miro-import/src/fake-miro.ts'
import { HOST, PORT_BASE } from './ports.ts'

export { FAKE_MIRO_TOKEN, type FakeMiro } from '../../../packages/miro-import/src/fake-miro.ts'
export {
  EMPTY_ID,
  RETRO_ID,
  SPRINT_ID,
  SPRINT_IDS,
} from '../../../packages/miro-import/src/fixtures.ts'

export const FAKE_MIRO_API_PORT = PORT_BASE === null ? 5920 : PORT_BASE + 20
export const FAKE_MIRO_FILES_PORT = PORT_BASE === null ? 5921 : PORT_BASE + 21
export const FAKE_MIRO_API = `http://${HOST}:${FAKE_MIRO_API_PORT}`
export const FAKE_MIRO_FILES = `http://${HOST}:${FAKE_MIRO_FILES_PORT}`

/** The api env of a stack whose Miro is the fake (both origins: files on). */
export const MIRO_API_ENV: Readonly<Record<string, string>> = {
  DRAFTROOM_MIRO_TEST_ORIGINS: `${FAKE_MIRO_API},${FAKE_MIRO_FILES}`,
}

/** The dashboard's Import menu with "From Miro…" (a dev-auth page's switches, import-menu/flags.ts). */
export const MIRO_MENU_STORAGE: Readonly<Record<string, string>> = {
  'lobby.importMenu': '1',
  'lobby.importMiro': '1',
}

export async function startE2eFakeMiro(): Promise<FakeMiro> {
  return startFakeMiro({ host: HOST, apiPort: FAKE_MIRO_API_PORT, filesPort: FAKE_MIRO_FILES_PORT })
}

/** Back to a fake that answers at once, files flowing, the token's scope intact. */
export function resetFakeMiro(miro: FakeMiro): void {
  Object.assign(miro.behaviour, {
    delayMs: 0,
    rateLimitNext: 0,
    fail: null,
    fileHost: 'files',
    expired: false,
    holdFiles: null,
    scopes: ['boards:read'],
  })
  miro.requests.length = 0
}
