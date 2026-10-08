// K6-2: the options every <ClerkProvider> of this app is given (ClerkSignIn.tsx for sign-in,
// clerkSession.tsx for the sign-out), so no provider can be added without them.
//
// Telemetry is off: clerk-js (@clerk/react 6.17.2, the `telemetry` option of @clerk/shared 4.36.0's
// ClerkOptions: `false | { disabled?, debug?, perEventSampling? }`) otherwise sends usage events from a
// development instance to clerk-telemetry.com, a host sign-in does not need (AGENTS.md: no request leaves
// Lobby's origins and the auth provider's beyond what sign-in needs; the CSP's connect-src does not list it).
//
// No @clerk/react value import: the type below is erased, so this module stays out of the Clerk chunk.
import type { ClerkProvider } from '@clerk/react'
import type { ComponentProps } from 'react'

export interface LobbyClerkOptions {
  readonly publishableKey: string
  readonly telemetry: false
}

/** Spread into every <ClerkProvider>: `<ClerkProvider {...clerkProviderOptions(key)} …>`. */
export function clerkProviderOptions(publishableKey: string): LobbyClerkOptions {
  return { publishableKey, telemetry: false }
}

// fails to compile if the provider stops taking these options under these names
type ProviderProps = ComponentProps<typeof ClerkProvider>
const accepted: Pick<ProviderProps, 'publishableKey' | 'telemetry'> = clerkProviderOptions('pk_test_x')
void accepted
