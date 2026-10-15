// render.yaml rewrites a miss under the static site's own asset prefixes (/excalidraw-assets/*, and since wave Q
// /lobby-assets/*) to the api, so that a missing font or icon file answers 404 and never the SPA's index.html (a JSON
// or font reader takes a 200 HTML answer for a broken file). That only holds while the api answers those paths with
// its plain 404: no route of the api may ever match them.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestApi, type TestApi } from './helpers.ts'

describe('the static prefixes the site rewrites to the api', () => {
  let api: TestApi
  beforeEach(async () => {
    api = await createTestApi()
  })
  afterEach(() => api.close())

  it.each([
    '/lobby-assets/icons/index.0123abcd.json',
    '/lobby-assets/icons/shard-7.0123abcd.json',
    '/lobby-assets/icons/LICENSES.txt',
    '/lobby-assets/anything/else',
    '/excalidraw-assets/fonts/Nunito/not-there.woff2',
  ])('GET %s answers the plain 404 (JSON, not HTML)', async (url) => {
    for (const method of ['GET', 'HEAD'] as const) {
      const res = await api.app.inject({ method, url })
      expect(res.statusCode, `${method} ${url}`).toBe(404)
      expect(String(res.headers['content-type'])).toMatch(/^application\/json/)
    }
    const res = await api.app.inject({ method: 'GET', url })
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.' } })
  })
})
