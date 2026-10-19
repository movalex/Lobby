// OWNER: WS5 (wave W, the workspace admin page; the stub landed by the wave W foundation, docs/WAVE-W-CONTRACTS.md §7).
// /w/:wid/admin: five tabs (contracts ADMIN_TABS: members, storage, audit log, guest links, retention), each from its
// owner/admin route (ADMIN_ROUTE_KEYS); every change it offers calls an EXISTING route; retention is read-only. Loaded
// only while FORMATS_FLAGS.admin is on (App.tsx), inside the session; anyone the api answers 404 sees the unknown-address
// screen. Until WS5 implements it, it is the unknown-address screen, as before wave W.
import { MessageScreen } from '../../ui/screens.tsx'

export default function AdminPage(_props: { workspaceId: string }) {
  return <MessageScreen title="Page not found" body="There is nothing at this address." />
}
