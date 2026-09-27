/** Saves a Blob through a temporary link (the object URL is revoked after the browser has taken it). */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.appendChild(link)
  try {
    link.click()
  } finally {
    link.remove()
    // Revoking right away can cancel the download in some browsers (Safari, Firefox).
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}
