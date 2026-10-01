// What of an error reaches the log (security audit L5): its name, message and code, never the object. A
// whole error carries its stack (file paths), and on the Excalidraw engine a converter's or node:sqlite's
// throw can carry record ids and local paths in properties; the api already logs {name, message, code}.

export interface ErrorSummary {
  name: string
  message: string
  code?: string
}

const MAX_MESSAGE = 300

/** `{name, message, code?}` of anything thrown; a non-Error becomes `{name: <typeof>, message: String(it)}`. */
export function errorSummary(e: unknown): ErrorSummary {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code
    return {
      name: e.name,
      message: e.message.slice(0, MAX_MESSAGE),
      ...(typeof code === 'string' || typeof code === 'number' ? { code: String(code) } : {}),
    }
  }
  return { name: typeof e, message: String(e).slice(0, MAX_MESSAGE) }
}

/** A log argument with every Error in it summarised (for log sinks that forward whatever a library passes). */
export const logSafe = (arg: unknown): unknown => (arg instanceof Error ? errorSummary(arg) : arg)
