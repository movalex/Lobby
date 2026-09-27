export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, '')} ${units[i]}`
}

/** 83_000 -> "1:23", 3_723_000 -> "1:02:03". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function pluralize(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

/** Short uppercase badge for the kind icon, e.g. "PDF", "MP4", "ZIP". */
export function extensionLabel(name: string, fallback: string): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]
  return (ext ?? fallback).toUpperCase().slice(0, 4)
}
