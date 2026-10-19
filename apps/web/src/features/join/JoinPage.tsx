// OWNER: WS3 (wave V, join codes; the stub landed by the wave V foundation, docs/WAVE-V-CONTRACTS.md §3). The /j/:code
// page: it reads the code (contracts normalizeJoinCode), asks GET /api/join/:code (no session needed) and continues
// at /invite/:token, whose name-only join is unchanged; an unknown, expired or revoked code (the api's one 404) says
// "This code does not work any more" with a field to type another. It is loaded only while LIVE_FLAGS.joinCodes is on
// (App.tsx); until WS3 implements it, it is the unknown-address screen, as before wave V.
import { MessageScreen } from '../../ui/screens.tsx'

export default function JoinPage(_props: { code: string }) {
  return <MessageScreen title="Page not found" body="There is nothing at this address." />
}
