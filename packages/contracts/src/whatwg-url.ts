// The WHATWG URL parser, typed for this package (its tsconfig has no DOM and no Node types, and both runtimes that use
// contracts, the browser and Node, have the same global URL). Only the parts the URL rules read.
//
// Do not import values from ./index.ts here: index.ts re-exports modules that import this one.

export interface WhatwgSearchParams {
  keys(): IterableIterator<string>
  get(name: string): string | null
  has(name: string): boolean
}

export interface WhatwgUrl {
  readonly href: string
  readonly protocol: string
  readonly username: string
  readonly password: string
  readonly hostname: string
  readonly port: string
  readonly pathname: string
  readonly search: string
  readonly hash: string
  readonly searchParams: WhatwgSearchParams
}

const URL_CONSTRUCTOR = (globalThis as unknown as { URL: new (input: string) => WhatwgUrl }).URL

/** `raw` parsed as an absolute URL, or null when it is not one. */
export function parseUrl(raw: string): WhatwgUrl | null {
  try {
    return new URL_CONSTRUCTOR(raw)
  } catch {
    return null
  }
}
