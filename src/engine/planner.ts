import type {
  AppState,
  Debt,
  OverdraftFeeEvent,
  Payday,
  PlanResult,
  PlannedPayment,
} from '../types'
import { cycleMinimum } from './minPayment'
import { addDays, daysBetween, nextDueDate, prevDueDate, todayISO } from './dates'

/** Planning horizon in days (~6 biweekly paychecks) */
export const HORIZON_DAYS = 84

/**
 * Overdraft-funded catch-ups are paid this many days before the creditor's
 * bureau-reporting date, since card payments can take a couple of days to post.
 */
export const BUREAU_SAFETY_DAYS = 2

interface Obligation {
  debtId: string
  debtName: string
  amount: number
  dueDate: string
  /** Earliest date the planner will spend cash on this */
  payableFrom: string
  /**
   * Last day to pay without penalty (the due date, or just before the bureau
   * reports a past-due account). Overdraft is only used on/after this day.
   * null = never worth overdrafting for.
   */
  deadline: string | null
  isPastDueCatchUp: boolean
  /** Past-due on a bureau-reporting debt: worth an overdraft fee to avoid a report */
  bureauCritical: boolean
  /** Fee the lender charges if this lands after dueDate */
  lateFee: number
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
 *
 * Overdraft: when `settings.overdraftLimit` > 0, a flexible payment that cash
 * can't cover may dip into overdraft — but only on its deadline day (the last
 * safe moment, so the account is negative as briefly as possible), never past
 * the limit, and only if that beats the alternative:
 *  - bureau-critical catch-ups always qualify (a bureau report is the worst outcome)
 *  - otherwise the overdraft must not cost a fee, or the fee must be smaller
 *    than the late fee it avoids.
 * The bank charges `overdraftFee` once per episode when the balance is still
 * negative on a second consecutive night; the planner looks one day ahead so
 * overdrafts that clear by the next morning are preferred (no fee).
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

  const overdraftLimit = Math.max(0, settings.overdraftLimit ?? 0)
  const overdraftFee = Math.max(0, settings.overdraftFee ?? 0)

  let cash = settings.bankBalance
  let day = today
  // consecutive nights (end of day) the balance has been below $0
  let negDays = 0
  let peakOverdraft = 0
  let overdraftFees = 0
  const overdraftFeeEvents: OverdraftFeeEvent[] = []

  // Money movements the plan can't change, used to peek at tomorrow's balance
  const forcedDelta = (d: string) =>
    (paydayByDate.get(d) ?? 0) +
    (oneTimeByDate.get(d) ?? 0) -
    autopays.filter((o) => o.dueDate === d).reduce((s, o) => s + o.amount, 0)

  // Will the bank charge an overdraft fee if the balance is `cashNow` today?
  // The fee lands when the balance is negative on a second consecutive night.
  const feeExpected = (from: string, cashNow: number): boolean => {
    if (overdraftFee <= 0 || cashNow >= 0 || negDays >= 2) return false
    if (negDays >= 1) return true // still negative tonight = second night
    return cashNow + forcedDelta(addDays(from, 1)) < 0
  }

  const fund = (ob: Obligation, d: string) => {
    ob.plannedDate = d
    cash -= ob.amount
    ob.balanceAfter = round2(cash)
  }

  while (day <= horizonEnd) {
    cash += paydayByDate.get(day) ?? 0
    cash += oneTimeByDate.get(day) ?? 0
    for (const ob of autopays) {
      if (ob.dueDate === day) fund(ob, day)
    }
    const reserve = autopayReserve(day)
    for (const ob of obligations) {
      if (ob.autopay || ob.plannedDate) continue
      if (day < ob.payableFrom) continue
      if (cash - reserve >= ob.amount) {
        fund(ob, day)
        continue
      }
      // Cash can't cover it. Is this the last safe day to use overdraft?
      if (overdraftLimit <= 0 || !ob.deadline) continue
      if (ob.bureauCritical ? day < ob.deadline : day !== ob.deadline) continue
      const after = cash - ob.amount
      const extraFee = feeExpected(day, after) && !feeExpected(day, cash) ? overdraftFee : 0
      const withinLimit = after - reserve - extraFee >= -overdraftLimit
      const worthIt = ob.bureauCritical || extraFee === 0 || ob.lateFee > extraFee
      if (withinLimit && worthIt) fund(ob, day)
    }

    // end of day: overdraft bookkeeping
    if (cash < 0) {
      negDays++
      if (negDays === 2 && overdraftFee > 0) {
        cash -= overdraftFee
        overdraftFees += overdraftFee
        overdraftFeeEvents.push({ date: day, amount: overdraftFee, balanceAfter: round2(cash) })
      }
    } else {
      negDays = 0
    }
    peakOverdraft = Math.max(peakOverdraft, -cash)
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
    lateFee: lateFeeFor(ob),
  }))

  const totalRequired = round2(obligations.reduce((s, o) => s + o.amount, 0))
  // Unfunded payments, plus the part of each autopay that overdraws past the bank's limit
  const shortfall = round2(
    obligations.reduce((s, o) => {
      if (!o.plannedDate) return s + o.amount
      if (o.autopay && (o.balanceAfter ?? 0) < -overdraftLimit) {
        return s + Math.min(o.amount, -(o.balanceAfter ?? 0) - overdraftLimit)
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
    overdraftFees: round2(overdraftFees),
    overdraftFeeEvents,
    lateFees: round2(payments.reduce((s, p) => s + p.lateFee, 0)),
    peakOverdraft: round2(peakOverdraft),
  }
}

/**
 * A regular payment that lands after its due date (or never gets funded inside
 * the horizon) earns the lender's late fee. Catch-ups are already late — that
 * fee has been charged and belongs in the past-due amount.
 */
function lateFeeFor(ob: Obligation): number {
  if (ob.isPastDueCatchUp || ob.lateFee <= 0) return 0
  return !ob.plannedDate || ob.plannedDate > ob.dueDate ? ob.lateFee : 0
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
        // pay a couple of days before the report date so the payment posts in time
        deadline: debt.reportsToBureau
          ? maxDate(today, addDays(since, bureauReportDays - 1 - BUREAU_SAFETY_DAYS))
          : null,
        bureauCritical: debt.reportsToBureau,
        lateFee: 0,
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
        deadline: due,
        bureauCritical: false,
        lateFee: debt.lateFee ?? 0,
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
  // Paid by dipping below $0 — the thing to watch, whether or not it's on time
  if ((ob.balanceAfter ?? 0) < 0) return 'overdraft'
  if (ob.autopay) return 'on_time'
  return ob.plannedDate <= ob.dueDate ? 'on_time' : 'late'
}

function maxDate(a: string, b: string): string {
  return a >= b ? a : b
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
