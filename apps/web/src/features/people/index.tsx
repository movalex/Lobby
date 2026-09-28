// Feature module: people (docs/WAVE4-CONTRACTS.md "present-live": the people list; checklist WRK-02,
// FAC-01, FAC-07..10's per-person "Bring to me"). The top bar renders PeopleTopBar where its avatars
// were (board/TopBar.tsx), plus present-live's chip. The feature's overlay names whom you follow.

import { useValue } from 'tldraw'
import type { BoardFeature, FeatureContext } from '../types.ts'
import { PersonName } from '../workshops/Hands.tsx'
import { useWorkshop } from '../workshops/hooks.ts'
import { usePresenting } from '../workshops/presenting.ts'
import './people.css'

export { LiveChip } from '../present-export/live/LiveUi.tsx'
export { PeopleTopBar } from './PeopleBar.tsx'

/**
 * FAC-01: "Following Bob" in Bob's color while your view follows someone (an avatar click, the
 * people list). tldraw draws the colored frame and its own "Stop following" button (the one way out
 * on screen, RETRO-11); after "Gather everyone" the workshops notice says it instead.
 */
function FollowingLabel({ ctx }: { ctx: FeatureContext }) {
  const { editor } = ctx
  const { snap } = useWorkshop(ctx)
  const presenting = usePresenting()
  const who = useValue('dr-people-following', () => {
    const id = editor.getInstanceState().followingUserId
    if (!id) return null
    const c = editor.getCollaborators().find((x) => x.userId === id)
    return c ? `${c.color}|${c.userName}` : null
  }, [editor])
  if (!who || presenting || snap.summonedBy) return null
  const [color = '', ...rest] = who.split('|')
  return (
    <div
      className="dr-people-following"
      data-testid="following-label"
      style={{ background: color }}
      role="status"
    >
      Following <PersonName name={rest.join('|')} className="dr-people-following__name" />
    </div>
  )
}

export const peopleFeature: BoardFeature = { id: 'people', Overlay: FollowingLabel }
