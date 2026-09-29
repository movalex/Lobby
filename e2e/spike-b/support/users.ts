// Dev users for spike B runs: a distinct dev handle per call (`<label>-<run>-<n>`, within the dev login's
// `^[a-z0-9-]{1,32}$`), so every browser process signs in as a different person and repeated runs on one
// stack never share a user. Dev sign-in puts every new user into "Dev Studio"; boards are created there
// by their owner and shared with explicit grants (stack.createBoard).
import type { DevUser } from './types.ts'

const RUN = `${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 36 * 36)
  .toString(36)
  .padStart(2, '0')}`
let n = 0

export function devUser(label: string): DevUser {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 10) || 'user'
  n++
  const handle = `${slug}-${RUN}-${n.toString(36)}`
  if (!/^[a-z0-9-]{1,32}$/.test(handle)) throw new Error(`dev handle ${handle} is not valid`)
  return { handle, name: `${label} ${n}`.slice(0, 60) }
}
