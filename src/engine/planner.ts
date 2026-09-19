import type {
  AppState,
  Debt,
  Payday,
  PlanResult,
  PlannedPayment,
} from '../types'
import { cycleMinimum } from './minPayment'
import { addDays, daysBetween, nextDueDate, prevDueDate, todayISO } from './dates'

/** Planning horizon in days (~6 biweekly paychecks) */
export const HORIZON_DAYS = 84

interface Obligation {
  debtId: string
  debtName: string
  amount: number
  dueDate: string
  /** Earliest date the planner will spend cash on this */
  payableFrom: string
  isPastDueCatchUp: boolean
  daysUntilReport?: number
  reportsToBureau: boolean
  /** Deducted on dueDate no matter what; never rescheduled */
  autopay: boolean
  // filled during simulation
  plannedDate: string | null
  balanceAfter?: number
}

/**
 * Builds a payment plan by simulating cash flow day by day.
 *
 * Priority: past-due catch-ups closest to bureau reporting first, then
 * everything else by due date. Each day, obligations are funded in priority
 * order from whatever cash is available; an obligation too big for today's
 * cash is retried after each payday.
 *
 * Autopay obligations are the exception: they are fixed-date. They leave the
 * account on their due date regardless of cash (possibly overdrawing it), and
 * flexible payments hold back whatever autopays need before the next inflow.
 */
export function buildPlan(state: AppState): PlanResult {
  const today = todayISO()
  const horizonEnd = addDays(today, HORIZON_DAYS)
  const { debts, settings } = state

  const paydays = buildPaydays(state, horizonEnd)
  const obligations = buildObligations(debts, settings.bureauReportDays, today, horizonEnd)

  // --- priority order ---
  obligations.sort((a, b) => {
    if (a.isPastDueCatchUp !== b.isPastDueCatchUp) return a.isPastDueCatchUp ? -1 : 1
    if (a.isPastDueCatchUp && b.isPastDueCatchUp) {
      // reporting debts before non-reporting; closest to reporting first
      if (a.reportsToBureau !== b.reportsToBureau) return a.reportsToBureau ? -1 : 1
      return (a.daysUntilReport ?? 999) - (b.daysUntilReport ?? 999)
    }
    return a.dueDate.localeCompare(b.dueDate)
  })

  // --- simulate cash day by day ---
  const paydayByDate = new Map(paydays.map((p) => [p.date, p.net]))
  const oneTimes = state.income.oneTimes
    .filter((e) => e.date >= today && e.date <= horizonEnd && e.amount > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
  const oneTimeByDate = new Map<string, number>()
  for (const e of oneTimes) {
    const signed = e.kind === 'in' ? e.amount : -e.amount
    oneTimeByDate.set(e.date, (oneTimeByDate.get(e.date) ?? 0) + signed)
  }
  const autopays = obligations.filter((o) => o.autopay)
  const inflowDates = [
    ...paydays.filter((p) => p.net > 0).map((p) => p.date),
    ...oneTimes.filter((e) => e.kind === 'in').map((e) => e.date),
  ].sort()
  // Cash that autopays still need before more money lands. An inflow on the
  // same day as an autopay is applied first, so it counts as covering it.
  const autopayReserve = (from: string) => {
    const nextInflow = inflowDates.find((d) => d > from) ?? '9999-12-31'
    return autopays
      .filter((o) => o.dueDate > from && o.dueDate < nextInflow)
      .reduce((s, o) => s + o.amount, 0)
  }

  let cash = settings.bankBalance
  let day = today
  while (day <= horizonEnd) {
    cash += paydayByDate.get(day) ?? 0
    cash += oneTimeByDate.get(day) ?? 0
    for (const ob of autopays) {
      if (ob.dueDate !== day) continue
      ob.plannedDate = day
      cash -= ob.amount
      ob.balanceAfter = round2(cash)
    }
    const reserve = autopayReserve(day)
    for (const ob of obligations) {
      if (ob.autopay || ob.plannedDate) continue
      if (day < ob.payableFrom) continue
      if (cash - reserve >= ob.amount) {
        ob.plannedDate = day
        cash -= ob.amount
        ob.balanceAfter = round2(cash)
      }
    }
    day = addDays(day, 1)
  }

  const payments: PlannedPayment[] = obligations.map((ob) => ({
    debtId: ob.debtId,
    debtName: ob.debtName,
    amount: round2(ob.amount),
    dueDate: ob.dueDate,
    plannedDate: ob.plannedDate,
    status: paymentStatus(ob),
    autopay: ob.autopay,
    isPastDueCatchUp: ob.isPastDueCatchUp,
    daysUntilReport: ob.daysUntilReport,
    balanceAfter: ob.balanceAfter,
  }))

  const totalRequired = round2(obligations.reduce((s, o) => s + o.amount, 0))
  // Unfunded payments, plus the part of each autopay that overdraws the account
  const shortfall = round2(
    obligations.reduce((s, o) => {
      if (!o.plannedDate) return s + o.amount
      if (o.autopay && (o.balanceAfter ?? 0) < 0) {
        return s + Math.min(o.amount, -(o.balanceAfter ?? 0))
      }
      return s
    }, 0),
  )

  return {
    payments,
    paydays,
    oneTimes,
    payoffOrder: buildPayoffOrder(debts, settings.strategy),
    totalRequired,
    shortfall,
    surplus: shortfall > 0 ? 0 : round2(Math.max(0, cash)),
  }
}

function buildPaydays(state: AppState, horizonEnd: string): Payday[] {
  const { income } = state
  const paydays: Payday[] = []
  if (!income.nextPayDate || income.payAmount <= 0) return paydays
  const advancesTotal = income.advances.reduce((s, a) => s + a.amount, 0)
  const living = income.livingExpenses ?? 0
  let date = income.nextPayDate
  let first = true
  while (date <= horizonEnd) {
    const deducted = first ? Math.min(advancesTotal, income.payAmount) : 0
    const livingDeducted = Math.min(living, Math.max(0, income.payAmount - deducted))
    paydays.push({
      date,
      gross: income.payAmount,
      advancesDeducted: round2(deducted),
      livingDeducted: round2(livingDeducted),
      net: round2(income.payAmount - deducted - livingDeducted),
    })
    date = addDays(date, income.frequencyDays)
    first = false
  }
  return paydays
}

function buildObligations(
  debts: Debt[],
  bureauReportDays: number,
  today: string,
  horizonEnd: string,
): Obligation[] {
  const obligations: Obligation[] = []
  for (const debt of debts) {
    if (debt.balance <= 0) continue
    const min = cycleMinimum(debt)

    if (debt.pastDue) {
      const amount = debt.pastDueAmount ?? min
      const since = debt.pastDueSince ?? prevDueDate(debt.dueDay, today)
      const daysPast = Math.max(0, daysBetween(since, today))
      obligations.push({
        debtId: debt.id,
        debtName: debt.name,
        amount: Math.min(amount, debt.balance),
        dueDate: since,
        payableFrom: today,
        isPastDueCatchUp: true,
        daysUntilReport: debt.reportsToBureau
          ? Math.max(0, bureauReportDays - daysPast)
          : undefined,
        reportsToBureau: debt.reportsToBureau,
        // a catch-up is a manual payment even on an autopay debt
        autopay: false,
        plannedDate: null,
      })
    }

    // regular cycle minimums for each due date in the horizon
    if (min <= 0) continue
    // Rent renews every month — don't stop when the entered balance runs out
    const recurring = debt.type === 'rent'
    let due = nextDueDate(debt.dueDay, today)
    let remaining = debt.balance - (debt.pastDue ? Math.min(debt.pastDueAmount ?? min, debt.balance) : 0)
    while (due <= horizonEnd && (recurring || remaining > 0)) {
      const amount = recurring ? min : Math.min(min, remaining)
      obligations.push({
        debtId: debt.id,
        debtName: debt.name,
        amount,
        dueDate: due,
        // don't tie up cash more than 7 days before the due date
        payableFrom: maxDate(today, addDays(due, -7)),
        isPastDueCatchUp: false,
        reportsToBureau: debt.reportsToBureau,
        autopay: debt.autopay === true,
        plannedDate: null,
      })
      remaining -= amount
      due = nextDueDate(debt.dueDay, addDays(due, 1))
    }
  }
  return obligations
}

function buildPayoffOrder(debts: Debt[], strategy: 'avalanche' | 'snowball') {
  // Rent is a recurring bill, not a payable-off debt
  const active = debts.filter((d) => d.balance > 0 && d.type !== 'rent')
  const sorted = [...active].sort((a, b) =>
    strategy === 'avalanche' ? b.apr - a.apr : a.balance - b.balance,
  )
  return sorted.map((d) => ({
    debtId: d.id,
    reason:
      strategy === 'avalanche'
        ? `${d.apr}% APR`
        : `$${d.balance.toLocaleString()} balance`,
  }))
}

function paymentStatus(ob: Obligation): PlannedPayment['status'] {
  if (!ob.plannedDate) return 'unfunded'
  if (ob.autopay) return (ob.balanceAfter ?? 0) < 0 ? 'overdraft' : 'on_time'
  return ob.plannedDate <= ob.dueDate ? 'on_time' : 'late'
}

function maxDate(a: string, b: string): string {
  return a >= b ? a : b
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
