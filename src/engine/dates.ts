/** Date helpers. All dates are handled as local-time 'YYYY-MM-DD' strings. */

export function todayISO(): string {
  return toISO(new Date())
}

export function toISO(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function parseISO(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

// The planner asks the same few hundred date questions hundreds of thousands of times,
// so these two are memoized (a Date object is built and thrown away on every miss).
const CACHE_LIMIT = 200_000
const addDaysCache = new Map<string, string>()
const daysBetweenCache = new Map<string, number>()

export function addDays(iso: string, days: number): string {
  const key = `${iso}|${days}`
  const hit = addDaysCache.get(key)
  if (hit !== undefined) return hit
  const d = parseISO(iso)
  d.setDate(d.getDate() + days)
  const out = toISO(d)
  if (addDaysCache.size > CACHE_LIMIT) addDaysCache.clear()
  addDaysCache.set(key, out)
  return out
}

export function daysBetween(fromISO: string, toISOstr: string): number {
  const key = `${fromISO}|${toISOstr}`
  const hit = daysBetweenCache.get(key)
  if (hit !== undefined) return hit
  const ms = parseISO(toISOstr).getTime() - parseISO(fromISO).getTime()
  const out = Math.round(ms / 86_400_000)
  if (daysBetweenCache.size > CACHE_LIMIT) daysBetweenCache.clear()
  daysBetweenCache.set(key, out)
  return out
}

/** Next occurrence of a day-of-month on or after `fromISO`, clamped to month length. */
export function nextDueDate(dueDay: number, fromISO: string): string {
  const from = parseISO(fromISO)
  const candidate = clampedDate(from.getFullYear(), from.getMonth(), dueDay)
  if (candidate.getTime() >= from.getTime()) return toISO(candidate)
  return toISO(clampedDate(from.getFullYear(), from.getMonth() + 1, dueDay))
}

/** The most recent occurrence of a day-of-month strictly before `fromISO`. */
export function prevDueDate(dueDay: number, fromISO: string): string {
  const from = parseISO(fromISO)
  const candidate = clampedDate(from.getFullYear(), from.getMonth(), dueDay)
  if (candidate.getTime() < from.getTime()) return toISO(candidate)
  return toISO(clampedDate(from.getFullYear(), from.getMonth() - 1, dueDay))
}

function clampedDate(year: number, month: number, day: number): Date {
  const lastDay = new Date(year, month + 1, 0).getDate()
  return new Date(year, month, Math.min(day, lastDay))
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = parseISO(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = parseISO(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
