/**
 * RFC 6266 Content-Disposition with an RFC 5987 `filename*` for the real (UTF-8) name and a
 * conservative ASCII `filename` fallback for old clients. The name is user-controlled, so both forms
 * are escaped: quotes, backslashes, control and non-ASCII characters never reach the header raw.
 */
export function contentDisposition(type: 'inline' | 'attachment', name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_') || 'file'
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(name)}`
}

const REPLACEMENT_CHAR = String.fromCharCode(0xfffd)

// encodeURIComponent leaves ' ( ) * ! unescaped, but RFC 5987 attr-char excludes them. It also throws
// on lone surrogates, so those become U+FFFD first.
const encodeRfc5987 = (s: string) =>
  encodeURIComponent(s.replace(/\p{Cs}/gu, REPLACEMENT_CHAR)).replace(
    /['()*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
