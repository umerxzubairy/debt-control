import type { AdvanceSettings, Income } from '../types'
import { addDays, daysBetween, nextDueDate, prevDueDate } from './dates'

/** One paycheck: when it lands and the work period it pays for. */
export interface Paycheck {
  date: string
  periodStart: string
  periodEnd: string
}

/**
 * Every paycheck landing from `today` through `until`, with the work period
 * each one pays for. Include dates past the planning horizon when you need to
 * know what's still unpaid near its end.
 */
export function buildPaychecks(income: Income, today: string, until: string): Paycheck[] {
  const out: Paycheck[] = []
  if (income.payAmount <= 0) return out

  if (income.scheduleKind === 'monthly') {
    for (const spec of income.monthlyPaychecks) {
      let date = nextDueDate(spec.payDay, today)
      while (date <= until) {
        // The period ends on the latest end-day before payday and starts on the
        // latest start-day on or before that end — e.g. paid the 1st for the
        // 8th–23rd of last month, paid the 15th for the 23rd–8th.
        const periodEnd = prevDueDate(spec.periodEndDay, date)
        const periodStart = prevDueDate(spec.periodStartDay, addDays(periodEnd, 1))
        out.push({ date, periodStart, periodEnd })
        date = nextDueDate(spec.payDay, addDays(date, 1))
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date))
  }

  const freq = income.frequencyDays
  if (!income.nextPayDate || freq <= 0) return out
  let date = income.nextPayDate
  while (date < today) date = addDays(date, freq)
  while (date <= until) {
    const periodEnd = addDays(date, -income.periodLagDays)
    out.push({ date, periodStart: addDays(periodEnd, -freq + 1), periodEnd })
    date = addDays(date, freq)
  }
  return out
}

/** Net wages earned so far in a paycheck's period, spread evenly across its days. */
export function earnedNet(p: Paycheck, payAmount: number, on: string): number {
  if (on < p.periodStart) return 0
  const total = daysBetween(p.periodStart, p.periodEnd) + 1
  const worked = Math.min(total, daysBetween(p.periodStart, on) + 1)
  return (payAmount * worked) / total
}

/** Net wages earned but not yet paid out on a given day (a paycheck lands at the start of its day). */
export function unpaidEarned(paychecks: Paycheck[], payAmount: number, on: string): number {
  let sum = 0
  for (const p of paychecks) {
    if (p.date > on) sum += earnedNet(p, payAmount, on)
  }
  return sum
}

/**
 * How much more can be advanced on a given day: the per-pay-period limit (a
 * share of one paycheck's net pay) minus what's already out — and, if
 * `limitToEarned` is on, no more than that share of the wages earned so far.
 */
export function advanceAvailable(
  paychecks: Paycheck[],
  payAmount: number,
  adv: AdvanceSettings,
  on: string,
  outstanding: number,
): number {
  const perPeriod = (adv.maxPercent / 100) * payAmount
  const limit = adv.limitToEarned
    ? Math.min(perPeriod, (adv.maxPercent / 100) * unpaidEarned(paychecks, payAmount, on))
    : perPeriod
  return Math.max(0, limit - outstanding)
}
