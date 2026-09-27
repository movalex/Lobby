export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Polls `check` until it returns a truthy value. `describe` is evaluated only on timeout, so it can
 * dump whatever state explains the failure.
 */
export async function waitFor<T>(
  check: () => T | undefined | null | false,
  opts: { timeoutMs?: number; intervalMs?: number; describe?: () => string } = {},
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000)
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor timed out after ${opts.timeoutMs ?? 10_000} ms${opts.describe ? `: ${opts.describe()}` : ''}`,
      )
    }
    await sleep(opts.intervalMs ?? 10)
  }
}
