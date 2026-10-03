// `vite preview` config for the whole-suite CSP audit (suite-audit.config.ts): apps/web's own config (the
// /api, /files and /connect proxy, the excalidraw-assets plugin) plus one response header,
// Content-Security-Policy-Report-Only = CSP_AUDIT_HEADER (suite-audit-policy.ts). Vite preview sets
// `preview.headers` on every static file and on the SPA fallback's index.html, as Render's `path: /*`
// header does on the static site; proxied /api and /files responses keep the api's own headers.
//
//   vite preview --config <this file> --outDir <build> --port <web port> --strictPort   (cwd: apps/web)
import web from '../../../apps/web/vite.config.ts'

const header = process.env.CSP_AUDIT_HEADER?.trim()
if (!header) throw new Error('CSP_AUDIT_HEADER must hold the Content-Security-Policy-Report-Only value')
// CSP_AUDIT_ENFORCE=1 sends the same value as the ENFORCED Content-Security-Policy, to see what a
// reported violation does to a feature once the policy blocks it.
const name =
  process.env.CSP_AUDIT_ENFORCE === '1' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only'

export default {
  ...web,
  preview: {
    ...web.preview,
    headers: { ...web.preview?.headers, [name]: header },
  },
}
