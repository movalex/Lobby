// DRAFTROOM_FEEDBACK_ADMINS (wave J5): the people who read the feedback inbox and mark items done. A comma
// list of exact email addresses, each matched against the person's STORED VERIFIED addresses of the running
// sign-in provider (the same rows that decide creators: auth/users.ts storedEmails), never against a name
// or a client-sent value. Unset or blank: nobody reads the inbox through the app (GET /internal/feedback,
// behind the internal secret, still works for the lead's tooling).
//
// Every entry goes through normalizeEmail (printable ASCII, lowercased, never a Clerk test-mode
// "+clerk_test" address), exactly like the creator exceptions. Fails closed: an invalid value throws, so
// the api does not start with a half-read list. Error messages name the variable and the 1-based entry
// number, never the value (an address is personal data).

import { normalizeEmail } from '../../auth/creators.ts'

/** At most this many addresses (a pilot has a handful of readers). */
export const MAX_FEEDBACK_ADMINS = 25

type Env = Record<string, string | undefined>

export function parseFeedbackAdmins(env: Env): readonly string[] {
  const raw = env.DRAFTROOM_FEEDBACK_ADMINS?.trim()
  if (!raw) return []
  const entries = raw
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
  if (entries.length > MAX_FEEDBACK_ADMINS)
    throw new Error(`DRAFTROOM_FEEDBACK_ADMINS lists more than ${MAX_FEEDBACK_ADMINS} addresses`)
  const out: string[] = []
  entries.forEach((entry, i) => {
    const email = normalizeEmail(entry)
    if (email === null)
      throw new Error(`DRAFTROOM_FEEDBACK_ADMINS entry ${i + 1} is not a valid email address`)
    if (!out.includes(email)) out.push(email)
  })
  return out
}
