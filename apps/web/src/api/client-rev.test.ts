// Migration 0024: every api request of this build declares its revision (@draftroom/contracts
// client-rev.ts), so the api may answer it the vote scope 'selection' and the notification kind
// 'access_granted'. A request without it gets neither (what a build from before 0024 can parse).
import { ListNotificationsResponse, LOBBY_CLIENT_HEADER, LOBBY_CLIENT_REV } from '@draftroom/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createApiClient } from './client.ts'

describe('api client: the build revision header', () => {
  it('rides on every request, GET and POST, and a caller cannot drop it', async () => {
    const sent: Record<string, string>[] = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push({ ...((init?.headers ?? {}) as Record<string, string>) })
      return Response.json({ notifications: [], unreadCount: 0 })
    }) as unknown as typeof fetch
    const { request } = createApiClient({ fetchImpl })
    await request('GET', '/api/me/notifications', { schema: ListNotificationsResponse })
    await request('POST', '/api/me/notifications/read', { body: { all: true }, schema: null })
    await request('GET', '/api/boards/b-1/workshop', {
      schema: null,
      headers: { [LOBBY_CLIENT_HEADER]: '0' },
    })
    expect(LOBBY_CLIENT_REV).toBeGreaterThanOrEqual(1)
    expect(sent.map((h) => h[LOBBY_CLIENT_HEADER])).toEqual(Array(3).fill(String(LOBBY_CLIENT_REV)))
  })
})
