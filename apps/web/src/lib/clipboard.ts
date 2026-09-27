/** Copies text; false when the browser refuses (no permission, insecure context, no focus). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export const absoluteUrl = (path: string) => `${location.origin}${path}`
