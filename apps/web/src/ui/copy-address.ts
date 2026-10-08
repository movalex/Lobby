// "Copy my address" (wave K, K4-4): puts the signed-in address on the clipboard so a person can send it to a
// colleague who invites it. The clipboard is the only place it goes: no mail is composed or sent, and no
// request is made. Bounded: only a plain address is copied (never a long or odd string), and a clipboard
// that never answers (a permission prompt nobody sees, an unfocused window) counts as a refusal after a
// moment, so the button never hangs and the screen can say what to do by hand.
import { copyText } from '../lib/clipboard.ts'

/** What the screen says when the browser would not copy. */
export const ADDRESS_COPY_FALLBACK = 'Select the address and press Ctrl+C'
/** The longest address that exists (RFC 5321); anything longer is not an address. */
export const ADDRESS_MAX_LENGTH = 254
/** How long the clipboard gets to answer. */
export const COPY_TIMEOUT_MS = 2000

/** A printable ASCII address: one "@", no spaces or control characters (what Lobby stores as an account email). */
export function isCopyableAddress(address: unknown): address is string {
  return (
    typeof address === 'string' &&
    address.length > 2 &&
    address.length <= ADDRESS_MAX_LENGTH &&
    /^[!-~]+$/.test(address) &&
    address.indexOf('@') > 0 &&
    address.indexOf('@') === address.lastIndexOf('@') &&
    address.indexOf('@') < address.length - 1
  )
}

/** Copies `address`; false when it is not an address, the browser refuses, or it does not answer in time. */
export async function copyAddress(
  address: unknown,
  write: (text: string) => Promise<boolean> = copyText,
  timeoutMs = COPY_TIMEOUT_MS,
): Promise<boolean> {
  if (!isCopyableAddress(address)) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      write(address).catch(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
