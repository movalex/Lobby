/** Lobby's field-level undo (plan §2.8). Pure and Node-testable; the adapter installs the patches. */
export {
  type ApplyContext,
  type ApplyResult,
  applyChanges,
  type Direction,
  type Skip,
  type SkipReason,
} from './apply.ts'
export {
  diffElement,
  type ElementChange,
  type FieldChange,
  type HistEl,
  type Scene,
  type Side,
} from './diff.ts'
export { fieldGroup, type GroupName, LOCAL_ONLY, SERVER_OWNED, unclassifiedFields } from './fields.ts'
export { type Ack, type AckResult, type Entry, LobbyHistory, type TrackedChange } from './stack.ts'
