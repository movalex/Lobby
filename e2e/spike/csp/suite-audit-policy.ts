// The staging web's Content-Security-Policy (enforced since 2026-10-03; docs/DEPLOY.md), translated for the e2e stack by the whole-suite CSP audit (suite-audit.config.ts).
//
// The translation keeps every directive verbatim except the staging sync origin, which becomes the local
// sync server's (http + ws on SYNC_PORT). Nothing else is needed for the local stack to mirror staging:
// the page reaches the api same-origin on both (Render's /api, /files, /excalidraw-assets rewrites on
// staging; the vite preview proxy and the excalidraw-assets plugin here), so 'self' covers it. Locally
// the board socket also goes same-origin (the preview's /connect proxy, ws://<web>/connect, which 'self'
// matches); on staging it goes to the sync origin, which the translated entries stand for. Clerk's
// origins stay as they are: the suite signs in with the dev provider and never loads Clerk.
//
// Only `report-uri` is appended (the audit's collector, suite-audit-collector.ts): the header is
// report-only, so the suite runs as usual while the browser reports what the enforced policy would block.

/**
 * The staging header value as enforced on draftroom-staging-web.onrender.com since 2026-10-03 (render.yaml). The
 * audit that preceded the switch ran the 2026-10-02 report-only value; its one real finding added blob: to
 * connect-src (exports of boards with file cards), and Clerk's documented Protect hosts were added with it.
 */
export const STAGING_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://splendid-flamingo-3744.clerk.accounts.dev https://challenges.cloudflare.com https://*.protect.clerk.com",
  "connect-src 'self' blob: https://draftroom-staging-sync.onrender.com wss://draftroom-staging-sync.onrender.com https://splendid-flamingo-3744.clerk.accounts.dev https://clerk-telemetry.com https://*.protect.clerk.com:*",
  "img-src 'self' blob: data: https://img.clerk.com",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
  'frame-src https://challenges.cloudflare.com https://*.protect.clerk.com',
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

export const STAGING_SYNC_HOST = 'draftroom-staging-sync.onrender.com'

export interface LocalPolicy {
  /** The Content-Security-Policy-Report-Only value served with every page and static file. */
  header: string
  /** Each change from STAGING_POLICY, for the audit's record. */
  translations: string[]
}

export function localPolicy(o: {
  host: string
  syncPort: number
  collectorPort: number
  /**
   * Extra connect-src sources for an experiment only (CSP_AUDIT_CONNECT_EXTRA), e.g. `data:` so a spec's
   * own pixel reader (a fetch of a data: URL from page.evaluate) keeps working under the enforced policy.
   */
  extraConnect?: readonly string[]
}): LocalPolicy {
  const translations: string[] = []
  let header = STAGING_POLICY
  if (o.extraConnect?.length) {
    header = header.replace("connect-src 'self'", `connect-src 'self' ${o.extraConnect.join(' ')}`)
    translations.push(`connect-src: added ${o.extraConnect.join(' ')} (experiment only)`)
  }
  for (const [from, to] of [
    [`https://${STAGING_SYNC_HOST}`, `http://${o.host}:${o.syncPort}`],
    [`wss://${STAGING_SYNC_HOST}`, `ws://${o.host}:${o.syncPort}`],
  ] as const) {
    if (!header.includes(from)) throw new Error(`the staging policy no longer has ${from}`)
    header = header.replace(from, to)
    translations.push(`connect-src: ${from} -> ${to}`)
  }
  const report = `http://${o.host}:${o.collectorPort}/csp-report`
  header = `${header}; report-uri ${report}`
  translations.push(`appended: report-uri ${report}`)
  return { header, translations }
}
