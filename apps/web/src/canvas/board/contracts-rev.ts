/**
 * Wave L foundation (owner W6, the CanvasPort owner of wave L): the contracts revision the board's room announced
 * on the current socket, behind `LobbyCanvas.room.contractsRev()`. The room sends its `contracts` frame once per
 * socket, right after the welcome (canvas-schema protocol.ts `Contracts`); every welcome starts a new socket, so
 * the revision is unknown (null) again until that socket's frame comes, and stays null for a room that sends none
 * (older than CONTRACTS_REV 10). A feature that would write what an older sync refuses (present.mins) or call
 * what it does not serve (restore-elements) offers it only while this says a revision new enough: null never is.
 *
 * Pure: the board session (./session.ts) feeds it the core's welcome and contracts messages.
 */
export class ContractsRevTracker {
  private rev: number | null = null
  private readonly onChange: () => void

  /** `onChange` runs whenever the value changes (the session's `room` concern). */
  constructor(onChange: () => void) {
    this.onChange = onChange
  }

  /** A welcome: a new socket, whose room has not said its revision yet. */
  welcome(): void {
    if (this.rev === null) return
    this.rev = null
    this.onChange()
  }

  /** The socket's `contracts` frame. */
  contracts(rev: number): void {
    if (!Number.isInteger(rev) || rev < 1 || this.rev === rev) return
    this.rev = rev
    this.onChange()
  }

  get(): number | null {
    return this.rev
  }
}
