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

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", "Sep 12", "Sep 12, 2025".
 * Local calendar days decide "yesterday"; clock skew (a time slightly in the future) reads "just now".
 */
export function formatRelativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return ''
  const then = new Date(iso)
  const t = then.getTime()
  if (!Number.isFinite(t)) return ''
  const diff = now.getTime() - t
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (t >= startOfToday) return `${Math.floor(diff / HOUR)} h ago`
  const days = Math.ceil((startOfToday - t) / DAY)
  if (days <= 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  const md = `${MONTHS[then.getMonth()]} ${then.getDate()}`
  return then.getFullYear() === now.getFullYear() ? md : `${md}, ${then.getFullYear()}`
}

/** "Oct 3, 2026, 14:05" in the viewer's locale; used for expiry dates. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
