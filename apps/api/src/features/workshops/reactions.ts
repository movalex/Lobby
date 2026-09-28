// Reactions (FAC-08): relayed to the board as events, never stored. The only state is two
// sliding-window rate limits kept in memory: per person (REACTION_RATE_MAX per
// REACTION_RATE_WINDOW_MS, across boards) and per board (REACTIONS_PER_BOARD_MAX per window, so a
// large room's applause cannot flood every open stream).

/** Relayed reactions per board per REACTION_RATE_WINDOW_MS, whoever sends them (then 429). */
export const REACTIONS_PER_BOARD_MAX = 100

// The limiter is shared with the API's other keyed limits (uploads, invitations, stream opens).
export { SlidingWindowLimiter } from '../../rate-limit.ts'
