// The one list of PORTED board features for the Excalidraw board page (docs/EXCALIDRAW-CONTRACTS.md §4,
// §7.2), in dock and registration order. Frozen at wave 1: each entry is its owner's file, created empty,
// so no wave-3 owner edits this list. A new feature is a change request. The tldraw page keeps
// features/registry.ts (BOARD_FEATURES) until wave 4. Wave L: W3 is this list's sole owner (it adds the wave L
// feature folders). Wave M: lead-only; the foundation registers 'ws-templates' and 'ai-workspace-ask' (W8's).
// Wave N: lead-only; the foundation registers 'visits' (WS4's) and 'board-links' (WS7's), empty. Reactions are inside
// workshops (WS3, workshops/ported/note-reactions.ts) and Capture the room inside ai (WS5): no feature of their own.
// Wave Q: lead-only; the foundation registers 'elements' (WS3's), contributing nothing while ELEMENTS_PANEL is false.
// Wave S: 'review' (WS1's), contributing nothing while REVIEW_FLAGS.status is off (the one line WS1 adds here).
// Wave T: lead-only; the foundation registers 'storyboard', 'storyboard-play', 'cards', 'kanban', 'card-table' and
// 'timeline', empty (each workstream fills its own; features/planning holds what they share).
import type { CanvasFeature } from '../canvas/api/index.ts'
import { feature as mediaFeature } from '../file-card/ported/index.tsx'
import { feature as a11yFeature } from './a11y/ported/index.tsx'
import { feature as aiFeature } from './ai/ported/index.tsx'
import { feature as aiWorkspaceAskFeature } from './ai/workspace-ask/ported/index.tsx'
import { feature as boardLinksFeature } from './board-links/index.tsx'
import { feature as canvasUxFeature } from './canvas-ux/ported/index.tsx'
import { feature as navigationFeature } from './canvas-ux/ported/navigation/index.tsx'
import { feature as cardTableFeature } from './card-table/index.tsx'
import { feature as cardsFeature } from './cards/index.tsx'
import { feature as commandPaletteFeature } from './command-palette/index.tsx'
import { feature as commentsFeature } from './comments/ported/index.tsx'
import { feature as cursorChatFeature } from './cursor-chat/ported/index.tsx'
import { feature as elementsFeature } from './elements/index.tsx'
import { feature as flowFeature } from './flow/ported/index.tsx'
import { feature as historyFeature } from './history/ported/index.tsx'
import { feature as kanbanFeature } from './kanban/index.tsx'
import { feature as mindmapFeature } from './mindmap/ported/index.tsx'
import { feature as peopleFeature } from './people/ported/index.tsx'
import { feature as piecesFeature } from './pieces/ported/index.tsx'
import { feature as presentLiveFeature } from './present-export/live/ported/index.tsx'
import { feature as presentExportFeature } from './present-export/ported/index.tsx'
import { feature as reviewFeature } from './review/index.tsx'
import { feature as reviewPageFeature } from './review-page/index.tsx'
import { feature as sharingFeature } from './sharing/ported/index.tsx'
import { feature as sortFeature } from './sort/ported/index.tsx'
import { feature as storyboardFeature } from './storyboard/index.tsx'
import { feature as storyboardPlayFeature } from './storyboard-play/index.tsx'
import { feature as tagsFeature } from './tags/ported/index.tsx'
import { feature as thumbnailsFeature } from './thumbnails/ported/index.tsx'
import { feature as timelineFeature } from './timeline/index.tsx'
import { feature as visitsFeature } from './visits/index.tsx'
import { feature as workshopsFeature } from './workshops/ported/index.tsx'
import { feature as wsTemplatesFeature } from './ws-templates/index.tsx'

export const CANVAS_FEATURES: readonly CanvasFeature[] = [
  canvasUxFeature,
  navigationFeature,
  commentsFeature,
  workshopsFeature,
  presentExportFeature,
  presentLiveFeature,
  historyFeature,
  sharingFeature,
  thumbnailsFeature,
  peopleFeature,
  mindmapFeature,
  tagsFeature,
  aiFeature,
  mediaFeature,
  // wave L (W4, L4-1/L4-3): flow building and Mermaid paste, BEFORE a11y (its contextual 'flow.repeat' is asked first)
  flowFeature,
  a11yFeature,
  // wave K (K6-4): cursor chat, a change request of its own (its '/' and its two overlays)
  cursorChatFeature,
  // wave L (W3, L3-2): the Ctrl/Cmd+K command palette (the wave L key claim 'palette'). W3 registers every
  // wave L feature folder here: features/flow (W4) goes BEFORE a11yFeature (its contextual 'flow.repeat' is
  // asked first); features/sort and features/pieces (W8) after this line. Each exports `feature` from index.tsx
  // (registered here by its ported/index.tsx re-export, the path the contracts test reads).
  commandPaletteFeature,
  // wave L (W8, L8-1/L8-2 and L8-3): sort and place, and the shape kits (Pieces), registered together
  sortFeature,
  piecesFeature,
  // wave M (registered empty by the foundation; W8 fills them): workspace templates and Ask across boards
  wsTemplatesFeature,
  aiWorkspaceAskFeature,
  // wave N (registered empty by the foundation; WS4 and WS7 fill them): since your last visit, links between boards
  visitsFeature,
  boardLinksFeature,
  // wave S (WS1; contributes nothing while REVIEW_FLAGS.status is off): review status (badges, the Review panel, the
  // menu entries, the review viewer's status slot)
  reviewFeature,
  // wave S (WS4): the client review page, the ?view=review overlay; nothing while its switch is off. Before the wave Q
  // entry, which the wave Q foundation's test pins as the last
  reviewPageFeature,
  // wave T (registered empty by the foundation; each contributes nothing while its PLANNING_FLAGS switch is off):
  // storyboards (WS2), the animatic (WS3), cards, Kanban and the card table (WS4), timelines (WS5)
  storyboardFeature,
  storyboardPlayFeature,
  cardsFeature,
  kanbanFeature,
  cardTableFeature,
  timelineFeature,
  // wave Q (registered by the foundation, hidden behind ELEMENTS_PANEL; WS3 fills it): the Elements panel
  elementsFeature,
]
