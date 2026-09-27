// The people of one e2e stack. Dev sign-in puts every new user into the shared "Dev Studio"
// workspace, and only its FIRST user becomes the workspace owner (= owner of every board in it). So
// alice signs in first, before any test runs: she owns Dev Studio, everyone else is a plain member
// who sees a Dev Studio board only once it is shared with them.
import { Api, type BoardRole, displayName, type RequestFactory } from './api.ts'

export interface TestUser {
  handle: string
  name: string
  id: string
  /** The workspace the user got on first sign-in; nobody else is a member of it. */
  personalWorkspaceId: string
}

export interface Users {
  /** The shared workspace (alice = owner, everyone else = member). */
  readonly devStudioId: string
  /** Signs `handle` in (creating the user on first use) and returns who it is. */
  get(handle: string): Promise<TestUser>
  /** A Node-side API client signed in as `handle`, for setup and server-side checks. */
  api(handle: string): Promise<Api>
  /** alice (owner) creates a private board in Dev Studio. */
  createBoard(title: string): Promise<string>
  /** alice gives `handle` an explicit grant on `boardId` (no-op for alice, who owns it). */
  grant(boardId: string, handle: string, role?: BoardRole): Promise<TestUser>
  dispose(): Promise<void>
}

export async function createUsers(playwright: RequestFactory): Promise<Users> {
  const known = new Map<string, Promise<{ api: Api; user: TestUser }>>()

  const signIn = (handle: string) => {
    let entry = known.get(handle)
    if (!entry) {
      entry = Api.signIn(playwright, handle, displayName(handle)).then(({ api, me }) => {
        // A new user owns exactly one workspace on first sign-in: their personal one.
        const personal = me.workspaces.find((w) => w.role === 'owner' && w.name.endsWith("'s workspace"))
        if (!personal) throw new Error(`${handle} has no personal workspace: ${JSON.stringify(me)}`)
        return {
          api,
          user: { handle, name: me.user.name, id: me.user.id, personalWorkspaceId: personal.id },
        }
      })
      known.set(handle, entry)
    }
    return entry
  }

  const alice = await signIn('alice')
  const aliceMe = await alice.api.me()
  const devStudio = aliceMe.workspaces.find((w) => w.name === 'Dev Studio')
  if (devStudio?.role !== 'owner') {
    throw new Error(
      `alice must be the first user of a fresh stack (Dev Studio owner): ${JSON.stringify(aliceMe)}`,
    )
  }

  const users: Users = {
    devStudioId: devStudio.id,
    get: async (handle) => (await signIn(handle)).user,
    api: async (handle) => (await signIn(handle)).api,
    createBoard: async (title) => (await alice.api.createBoard(devStudio.id, title)).id,
    grant: async (boardId, handle, role = 'editor') => {
      const user = (await signIn(handle)).user
      if (handle !== 'alice') await alice.api.putMember(boardId, user.id, role)
      return user
    },
    dispose: async () => {
      const all = await Promise.allSettled(known.values())
      await Promise.all(all.map((r) => (r.status === 'fulfilled' ? r.value.api.dispose() : undefined)))
    },
  }
  return users
}
