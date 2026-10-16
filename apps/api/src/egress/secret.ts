// A secret the api holds in memory only (wave R: a Miro access token a person pasted for one import job; a chat hook's
// opened URL while it is posted to). It prints as `[redacted]` in every way JavaScript and Node print a value
// (String(), template literals, JSON.stringify, util.inspect, console, pino's serializers), so no log line, error
// message, response or database row can carry it by accident; the value itself is reachable only through `reveal()`,
// which only the egress module calls, right where it writes the Authorization header (or opens the hook's URL).
//
// `redact()` scrubs a text of every known secret (as written and percent-encoded): the last line of defence for text
// that came from elsewhere (another service's error message) before it is kept or logged. Nothing here logs.

import { inspect } from 'node:util'

export const REDACTED = '[redacted]'

export class RedactedSecret {
  readonly #value: string

  constructor(value: string) {
    if (typeof value !== 'string' || value.length === 0)
      throw new TypeError('a secret must be a non-empty string')
    this.#value = value
  }

  /** The value, for the one place that sends it. Never log, store or return what this gives. */
  reveal(): string {
    return this.#value
  }

  /** Whether `text` holds this secret (as written, or percent-encoded). */
  isIn(text: string): boolean {
    return text.includes(this.#value) || text.includes(encodeURIComponent(this.#value))
  }

  toString(): string {
    return REDACTED
  }

  toJSON(): string {
    return REDACTED
  }

  [Symbol.toPrimitive](): string {
    return REDACTED
  }

  [inspect.custom](): string {
    return REDACTED
  }
}

/** `text` with every occurrence of each secret (as written and percent-encoded) replaced by `[redacted]`. */
export function redact(text: string, secrets: Iterable<RedactedSecret>): string {
  let out = text
  for (const s of secrets) {
    const raw = s.reveal()
    for (const form of new Set([raw, encodeURIComponent(raw)])) out = out.split(form).join(REDACTED)
  }
  return out
}
