// K6-2: how this api builds every Clerk Backend API client (auth/clerk.ts for sign-in, the profile refresh
// and "sign out everywhere"; features/dashboard/clerk-directory.ts for invite by email).
//
// Telemetry is off in code. @clerk/backend 3.20.1 (dist/index.mjs createClerkClient) builds a
// TelemetryCollector with every client; against a development instance it is enabled unless the options say
// `telemetry: { disabled: true }` or CLERK_TELEMETRY_DISABLED is set, and its constructor prints Clerk's
// "collects telemetry" notice to the process log (@clerk/shared 4.36.0 telemetry notice.ts). Its events go
// to clerk-telemetry.com, a host that sign-in does not need (AGENTS.md: no request leaves Lobby's origins
// and the auth provider's beyond what sign-in needs). An option rather than only an environment variable,
// so no deploy setting can forget it.
//
// verifyToken (the token check of every sign-in) builds no collector.

import type { ClerkOptions } from '@clerk/backend'

export interface ClerkKeys {
  secretKey: string
  publishableKey: string
}

/** The one options object every createClerkClient call of this api uses. */
export function clerkClientOptions(keys: ClerkKeys): ClerkOptions & {
  telemetry: { disabled: true }
} {
  return { secretKey: keys.secretKey, publishableKey: keys.publishableKey, telemetry: { disabled: true } }
}
