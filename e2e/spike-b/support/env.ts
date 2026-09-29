// Imported FIRST by every O3 module that reaches e2e/tests/support/** (and by harness.ts): the e2e
// launcher and its api client read their ports from E2E_PORT_BASE when their modules load
// (e2e/tests/support/ports.ts), so the spike B stack's base must be in the environment before that.
// The base is SPIKE_B_PORT_BASE (support/ports.ts; default the lead's integration stack 7850), the same
// one playwright.config.ts builds and serves the web app for.
import { type StackPorts, stackFromEnv } from './ports.ts'

export const SPIKE_B_STACK: StackPorts = stackFromEnv()

process.env.E2E_PORT_BASE = String(SPIKE_B_STACK.base)
// single-port overrides would split the stack from the web build's proxy targets
delete process.env.E2E_SYNC_PORT
delete process.env.E2E_API_PORT
delete process.env.E2E_WEB_PORT
