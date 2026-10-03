// The server's maintenance switch, as the migration service reads it (security audit L6: `convert-all`
// is refused while maintenance is off unless the call says {"confirm": true}). app.ts owns the switch
// (one sync server per process) and registers a getter here at start. The rooms' write paths read the
// same switch through `ElementRoomDeps.maintenance` (engine-switch.ts, OPEN16); the migration service is
// not built from those deps, so it reads it through this module, like backup/engine.ts carries the engine
// for the backup tools. Unregistered (unit tests, the B8 scripts' direct calls): null, and the
// service applies no precondition.

let getter: (() => boolean) | null = null

/** app.ts: the live switch (null on close). */
export function registerMaintenanceState(fn: (() => boolean) | null): void {
  getter = fn
}

/** Whether maintenance is on; null when no server registered its switch in this process. */
export function maintenanceState(): boolean | null {
  return getter ? getter() : null
}
