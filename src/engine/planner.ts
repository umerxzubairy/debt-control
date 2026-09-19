import type {
  AppState,
  Debt,
  OneTimeEvent,
  OverdraftFeeEvent,
  Payday,
  PlanResult,
  PlannedAdvance,
  PlannedPayment,
} from '../types'
import { cycleMinimum } from './minPayment'
import { addDays, daysBetween, nextDueDate, prevDueDate, todayISO } from './dates'
import { advanceAvailable, buildPaychecks, type Paycheck } from './paychecks'

/** Planning horizon in days (~6 biweekly paychecks) */
export const HORIZON_DAYS = 84

/**
 * Overdraft-funded catch-ups are paid this many days before the creditor's
 * bureau-reporting date, since card payments can take a couple of days to post.
 */
export const BUREAU_SAFETY_DAYS = 2

/**
 * What a late payment is assumed to cost when the debt has no late fee set —
 * used only to decide whether a pay-advance fee is worth paying to be on time.
 */
export const LATE_PENALTY = 50

/** Cost of letting a past-due account reach the bureau-reporting date */
const BUREAU_PENALTY = 1_000_000

const MAX_ADVANCE_ROUNDS = 30

interface Obligation {
  debtId: string
  debtName: string
  amount: number
  dueDate: string
  /** Earliest date the planner will spend cash on this */
  payableFrom: string
  /**
   * Last day to pay without penalty (the due date, or just before the bureau
   * reports a past-due account). Overdraft and advances are only used on/after
   * this day. null = never worth borrowing for.
   */
  deadline: string | null
  isPastDueCatchUp: boolean
  /** Past-due on a bureau-reporting debt: worth an overdraft fee to avoid a report */
  bureauCritical: boolean
  /** The day the creditor reports this past-due account to the bureaus */
  reportDate: string | null
  /** Fee the lender charges if this lands after dueDate */
  lateFee: number
  daysUntilReport?: number
  reportsToBureau: boolean
  /** Deducted on dueDate no matter what; never rescheduled */
  autopay: boolean
  // filled during simulation
  plannedDate: string | null
  balanceAfter?: number
  /** How much cash was missing on the deadline day (drives pay-advance sizing) */
  shortBy?: number
}

/** A pay advance the planner is considering / has decided to take */
interface AdvanceReq {
  requestDate: string
  amount: number
  forDebts: string[]
}

interface Ctx {
  state: AppState
  today: string
  horizonEnd: string
  /** Paychecks through a pay period past the horizon, so availability near its end is right */
  paychecks: Paycheck[]
  oneTimes: OneTimeEvent[]
  overdraftLimit: number
  overdraftFee: number
}

interface Sim {
  obligations: Obligation[]
  paydays: Payday[]
  /** Bank balance at the end of the horizon */
  cash: number
  overdraftFees: number
  feeEvents: OverdraftFeeEvent[]
  peakOverdraft: number
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
 *
 * Pay advances: when `advance.enabled`, payments that would still be late (or
 * cost an overdraft fee) get a pay advance requested `leadDays` before their
 * deadline, sized to the missing cash, if the employer's limits allow it. Each
 * candidate advance is tried by re-running the whole simulation and kept only
 * if the plan gets cheaper overall — the advance and its fee come out of the
 * next paycheck, which can squeeze later payments. Nearby needs top up an
 * existing advance instead of paying a second fee.
 */
export function buildPlan(state: AppState): PlanResult {
  const today = todayISO()
  const horizonEnd = addDays(today, HORIZON_DAYS)
  const { settings } = state

  const oneTimes = state.income.oneTimes
    .filter((e) => e.date >= today && e.date <= horizonEnd && e.amount > 0)
    .sort((a, b) => a.date.localeCompare(b.date))

  const ctx: Ctx = {
    state,
    today,
    horizonEnd,
    paychecks: buildPaychecks(state.income, today, addDays(horizonEnd, 45)),
    oneTimes,
    overdraftLimit: Math.max(0, settings.overdraftLimit ?? 0),
    overdraftFee: Math.max(0, settings.overdraftFee ?? 0),
  }

  let advances: AdvanceReq[] = []
  let sim = simulate(ctx, advances)

  if (state.advance.enabled) {
    const skipped = new Set<string>()
    for (let round = 0; round < MAX_ADVANCE_ROUNDS; round++) {
      const better = improveWithAdvance(ctx, advances, sim, skipped)
      if (!better) break
      advances = better.advances
      sim = better.sim
    }

    // Advances requested the same day arrive together and come out of the same
    // check, so they only need one transfer — and one fee.
    const merged = mergeSameDay(advances)
    if (merged.length < advances.length) {
      const mergedSim = simulate(ctx, merged)
      if (score(ctx, mergedSim, merged) <= score(ctx, sim, advances)) {
        advances = merged
        sim = mergedSim
      }
    }
  }

  return toResult(ctx, sim, advances)
}

function mergeSameDay(advances: AdvanceReq[]): AdvanceReq[] {
  const byDay = new Map<string, AdvanceReq>()
  for (const a of advances) {
    const seen = byDay.get(a.requestDate)
    byDay.set(
      a.requestDate,
      seen
        ? { ...seen, amount: seen.amount + a.amount, forDebts: [...seen.forDebts, ...a.forDebts] }
        : a,
    )
  }
  return [...byDay.values()]
}

// ---------------------------------------------------------------------------
// Cash simulation
// ---------------------------------------------------------------------------

function simulate(ctx: Ctx, advances: AdvanceReq[]): Sim {
  const { state, today, horizonEnd, overdraftLimit, overdraftFee } = ctx
  const obligations = buildObligations(state.debts, state.settings.bureauReportDays, today, horizonEnd)

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

  const paydays = buildPaydays(ctx, advances)
  const paydayByDate = new Map(paydays.map((p) => [p.date, p.net]))
  const oneTimeByDate = new Map<string, number>()
  for (const e of ctx.oneTimes) {
    const signed = e.kind === 'in' ? e.amount : -e.amount
    oneTimeByDate.set(e.date, (oneTimeByDate.get(e.date) ?? 0) + signed)
  }
  const arrivalByDate = new Map<string, number>()
  for (const a of advances) {
    const arrives = addDays(a.requestDate, state.advance.leadDays)
    arrivalByDate.set(arrives, (arrivalByDate.get(arrives) ?? 0) + a.amount)
  }

  const autopays = obligations.filter((o) => o.autopay)
  const inflowDates = [
    ...paydays.filter((p) => p.net > 0).map((p) => p.date),
    ...ctx.oneTimes.filter((e) => e.kind === 'in').map((e) => e.date),
    ...arrivalByDate.keys(),
  ].sort()
  // Cash that autopays still need before more money lands. An inflow on the
  // same day as an autopay is applied first, so it counts as covering it.
  const autopayReserve = (from: string) => {
    const nextInflow = inflowDates.find((d) => d > from) ?? '9999-12-31'
    return autopays
      .filter((o) => o.dueDate > from && o.dueDate < nextInflow)
      .reduce((s, o) => s + o.amount, 0)
  }

  let cash = state.settings.bankBalance
  let day = today
  // consecutive nights (end of day) the balance has been below $0
  let negDays = 0
  let peakOverdraft = 0
  let overdraftFees = 0
  const feeEvents: OverdraftFeeEvent[] = []

  // Money movements the plan can't change, used to peek at tomorrow's balance
  const forcedDelta = (d: string) =>
    (paydayByDate.get(d) ?? 0) +
    (oneTimeByDate.get(d) ?? 0) +
    (arrivalByDate.get(d) ?? 0) -
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

  // --- protecting payments that must beat a bureau report ---
  // Money you can count on by a future day: today's balance, the forced money
  // movements in between, and the overdraft room. Prefix sums make "what lands
  // between today and D" a subtraction.
  const days: string[] = []
  for (let d = today; d <= horizonEnd; d = addDays(d, 1)) days.push(d)
  const dayIndex = new Map(days.map((d, i) => [d, i]))
  const cumFlow: number[] = []
  days.reduce((run, d) => {
    const next = run + forcedDelta(d)
    cumFlow.push(next)
    return next
  }, 0)
  const flowBetween = (from: string, to: string) =>
    (cumFlow[dayIndex.get(to > horizonEnd ? horizonEnd : to) ?? 0] ?? 0) -
    (cumFlow[dayIndex.get(from) ?? 0] ?? 0)
  // Order in which unpaid bureau-critical catch-ups need their money
  const criticalOrder = obligations
    .filter((o) => o.bureauCritical && !o.autopay)
    .map((o, i) => ({ o, i }))
    .sort((a, b) => (a.o.deadline ?? '').localeCompare(b.o.deadline ?? '') || a.i - b.i)
    .map((x) => x.o)

  /**
   * Would paying `x` today still leave enough (cash + inflows before its
   * deadline + overdraft room) for every more urgent bureau-critical catch-up
   * that could be paid at all? Otherwise the overdraft room and cash get eaten
   * by bills that only cost a late fee while an account heads for the bureaus.
   */
  const roomForBureau = (x: Obligation, from: string): boolean => {
    let committed = 0
    for (const y of criticalOrder) {
      if (y === x) break // only catch-ups more urgent than x matter to x
      if (y.plannedDate) continue
      const by = (y.deadline ?? from) < from ? from : (y.deadline ?? from)
      const flows = flowBetween(from, by)
      // room = balance + inflows + overdraft. Using overdraft may cost a fee — unless
      // this overdraft episode has already been charged (it's charged once).
      const room = (balance: number, need: number) =>
        balance + flows + overdraftLimit - (balance + flows < need && negDays < 2 ? overdraftFee : 0)
      if (committed + y.amount > room(cash, committed + y.amount)) continue // can't be paid anyway
      committed += y.amount
      if (room(cash - x.amount, committed) < committed) return false
    }
    return true
  }

  while (day <= horizonEnd) {
    cash += paydayByDate.get(day) ?? 0
    cash += oneTimeByDate.get(day) ?? 0
    cash += arrivalByDate.get(day) ?? 0
    for (const ob of autopays) {
      if (ob.dueDate === day) fund(ob, day)
    }
    const reserve = autopayReserve(day)
    for (const ob of obligations) {
      if (ob.autopay || ob.plannedDate) continue
      if (day < ob.payableFrom) continue
      const affordable = cash - reserve >= ob.amount
      if (affordable && roomForBureau(ob, day)) {
        fund(ob, day)
        continue
      }
      // Not paid from cash: either it can't cover it, or the cash is being held
      // for a bureau-critical catch-up. Is this the last safe day to borrow for it?
      const deadline = ob.deadline
      if (deadline === null) continue
      if (ob.bureauCritical ? day < deadline : day !== deadline) continue
      // A payment about to be reported beats the autopay hold-back: if the cash is
      // there, use it (a later autopay may then overdraw, which the plan flags).
      if (ob.bureauCritical && cash >= ob.amount && roomForBureau(ob, day)) {
        fund(ob, day)
        continue
      }
      if (ob.shortBy === undefined) {
        // held-back cash means a pay advance would have to cover the whole payment
        ob.shortBy = affordable ? ob.amount : ob.amount - (cash - reserve)
      }
      if (overdraftLimit <= 0) continue
      const after = cash - ob.amount
      const extraFee = feeExpected(day, after) && !feeExpected(day, cash) ? overdraftFee : 0
      // Same rule for overdraft room: honour the autopay hold-back unless that would
      // leave a payment headed for the bureaus unpaid.
      const holdBack = ob.bureauCritical && after - reserve - extraFee < -overdraftLimit ? 0 : reserve
      const withinLimit = after - holdBack - extraFee >= -overdraftLimit
      const worthIt = ob.bureauCritical || extraFee === 0 || ob.lateFee > extraFee
      if (withinLimit && worthIt && roomForBureau(ob, day)) fund(ob, day)
    }

    // end of day: overdraft bookkeeping
    if (cash < 0) {
      negDays++
      if (negDays === 2 && overdraftFee > 0) {
        cash -= overdraftFee
        overdraftFees += overdraftFee
        feeEvents.push({ date: day, amount: overdraftFee, balanceAfter: round2(cash) })
      }
    } else {
      negDays = 0
    }
    peakOverdraft = Math.max(peakOverdraft, -cash)
    day = addDays(day, 1)
  }

  return { obligations, paydays, cash, overdraftFees, feeEvents, peakOverdraft }
}

/**
 * Paydays inside the horizon, net of what comes out of each check: money owed
 * from pay advances (repaid from the first payday after the advance, carrying
 * over if a check can't cover it all) and the living-expenses set-aside.
 */
function buildPaydays(ctx: Ctx, advances: AdvanceReq[]): Payday[] {
  const { income } = ctx.state
  const fee = ctx.state.advance.fee
  const living = income.livingExpenses ?? 0
  // advances already taken and recorded by the user come out of the next check
  let owed = income.advances.reduce((s, a) => s + a.amount, 0)
  const counted = new Set<AdvanceReq>()
  const paydays: Payday[] = []
  for (const p of ctx.paychecks) {
    if (p.date > ctx.horizonEnd) break
    for (const a of advances) {
      if (!counted.has(a) && a.requestDate < p.date) {
        owed += a.amount + fee
        counted.add(a)
      }
    }
    const deducted = Math.min(owed, income.payAmount)
    owed -= deducted
    const livingDeducted = Math.min(living, Math.max(0, income.payAmount - deducted))
    paydays.push({
      date: p.date,
      gross: income.payAmount,
      advancesDeducted: round2(deducted),
      livingDeducted: round2(livingDeducted),
      net: round2(income.payAmount - deducted - livingDeducted),
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
    })
  }
  return paydays
}

// ---------------------------------------------------------------------------
// Pay advances
// ---------------------------------------------------------------------------

const obligationKey = (ob: Obligation) => `${ob.debtId}|${ob.dueDate}|${ob.isPastDueCatchUp}`

/** Paid too late to avoid its penalty (late fee / bureau report)? */
function missed(ob: Obligation): boolean {
  if (ob.isPastDueCatchUp) {
    return ob.bureauCritical && (!ob.plannedDate || ob.plannedDate > (ob.deadline ?? ob.dueDate))
  }
  return !ob.plannedDate || ob.plannedDate > ob.dueDate
}

/** Lower is better. Fees are real dollars; a missed payment costs its late fee (or an assumed penalty). */
function score(ctx: Ctx, sim: Sim, advances: AdvanceReq[]): number {
  let s = sim.overdraftFees + advances.length * ctx.state.advance.fee + sim.peakOverdraft * 0.05
  for (const ob of sim.obligations) {
    if (ob.autopay || !missed(ob)) continue
    if (ob.isPastDueCatchUp) s += BUREAU_PENALTY
    else s += ob.lateFee > 0 ? ob.lateFee : LATE_PENALTY
  }
  return s
}

/** Could a pay advance have helped this obligation? */
function needsAdvance(ob: Obligation, sim: Sim): boolean {
  if (ob.autopay || ob.deadline === null || ob.shortBy === undefined) return false
  const viaOverdraft = (ob.balanceAfter ?? 0) < 0
  return missed(ob) || (viaOverdraft && sim.overdraftFees > 0)
}

/** First payday after `a` was requested, i.e. the check the advance comes out of */
function repayDateFor(ctx: Ctx, a: AdvanceReq): string | null {
  return ctx.paychecks.find((p) => p.date > a.requestDate)?.date ?? null
}

/** Advance principal outstanding on `on`, from advances requested earlier (`before`) and those the user recorded */
function outstandingOn(ctx: Ctx, before: AdvanceReq[], on: string): number {
  const first = ctx.paychecks[0]?.date
  const recorded =
    first === undefined || on < first
      ? ctx.state.income.advances.reduce((s, a) => s + a.amount, 0)
      : 0
  return (
    recorded +
    before
      .filter((b) => {
        const repay = repayDateFor(ctx, b)
        return repay === null || repay > on
      })
      .reduce((s, b) => s + b.amount, 0)
  )
}

function availableOn(ctx: Ctx, before: AdvanceReq[], on: string): number {
  return advanceAvailable(
    ctx.paychecks,
    ctx.state.income.payAmount,
    ctx.state.advance,
    on,
    outstandingOn(ctx, before, on),
  )
}

/** Does every advance stay within what the employer would allow on its request date? */
function advancesValid(ctx: Ctx, advances: AdvanceReq[]): boolean {
  const order = advances
    .map((a, i) => ({ a, i }))
    .sort((x, y) => x.a.requestDate.localeCompare(y.a.requestDate) || x.i - y.i)
  for (let k = 0; k < order.length; k++) {
    const { a } = order[k]
    if (a.requestDate < ctx.today) return false
    const earlier = order.slice(0, k).map((o) => o.a)
    if (a.amount > availableOn(ctx, earlier, a.requestDate) + 1e-9) return false
  }
  return true
}

/**
 * Try to fix the most urgent payment that a pay advance could rescue. Returns
 * the improved advances + simulation, or null when nothing helps.
 */
function improveWithAdvance(
  ctx: Ctx,
  advances: AdvanceReq[],
  sim: Sim,
  skipped: Set<string>,
): { advances: AdvanceReq[]; sim: Sim } | null {
  const lead = ctx.state.advance.leadDays
  const base = score(ctx, sim, advances)

  const candidates = sim.obligations
    .map((ob, i) => ({ ob, i }))
    .filter(({ ob }) => needsAdvance(ob, sim) && !skipped.has(obligationKey(ob)))
    // Payments headed for a bureau report get first call on the advance limit
    .sort(
      (a, b) =>
        Number(b.ob.bureauCritical) - Number(a.ob.bureauCritical) ||
        (a.ob.deadline ?? '').localeCompare(b.ob.deadline ?? '') ||
        a.i - b.i,
    )

  for (const { ob } of candidates) {
    const deadline = ob.deadline as string
    const need = Math.ceil(ob.shortBy ?? 0)
    const request = addDays(deadline, -lead)
    const options: AdvanceReq[][] = []

    if (request >= ctx.today && need > 0) {
      // Top up an advance that's already out and still unpaid on this deadline:
      // one fee instead of two.
      advances.forEach((a, idx) => {
        const repay = repayDateFor(ctx, a)
        const arrives = addDays(a.requestDate, lead)
        if (arrives <= deadline && (repay === null || repay > deadline)) {
          const next = advances.map((x, j) =>
            j === idx ? { ...x, amount: x.amount + need, forDebts: [...x.forDebts, ob.debtName] } : x,
          )
          if (advancesValid(ctx, next)) options.push(next)
        }
      })
      // A new advance, trimmed to what's available that day
      const amount = Math.min(need, Math.floor(availableOn(ctx, advances, request)))
      if (amount >= 1) {
        const next = [...advances, { requestDate: request, amount, forDebts: [ob.debtName] }]
        if (advancesValid(ctx, next)) options.push(next)
      }
    }

    let best: { advances: AdvanceReq[]; sim: Sim; score: number } | null = null
    for (const next of options) {
      const nextSim = simulate(ctx, next)
      const nextScore = score(ctx, nextSim, next)
      if (nextScore < base - 1e-6 && (!best || nextScore < best.score)) {
        best = { advances: next, sim: nextSim, score: nextScore }
      }
    }
    if (best) return best
    skipped.add(obligationKey(ob))
  }
  return null
}

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

function toResult(ctx: Ctx, sim: Sim, advances: AdvanceReq[]): PlanResult {
  const { state, overdraftLimit } = ctx
  const { obligations, paydays, cash, overdraftFees, feeEvents, peakOverdraft } = sim
  const adv = state.advance

  const plannedAdvances: PlannedAdvance[] = advances
    .map((a) => ({
      requestDate: a.requestDate,
      arrivalDate: addDays(a.requestDate, adv.leadDays),
      amount: a.amount,
      fee: adv.fee,
      repayDate: repayDateFor(ctx, a),
      forDebts: [...new Set(a.forDebts)],
    }))
    .sort((a, b) => a.requestDate.localeCompare(b.requestDate))

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
    missesBureau:
      ob.bureauCritical &&
      ob.reportDate !== null &&
      (!ob.plannedDate || ob.plannedDate >= ob.reportDate),
    advanceRequestDate: ob.autopay
      ? undefined
      : plannedAdvances.find(
          (a) => a.forDebts.includes(ob.debtName) && ob.plannedDate && a.arrivalDate <= ob.plannedDate,
        )?.requestDate,
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
    oneTimes: ctx.oneTimes,
    payoffOrder: buildPayoffOrder(state.debts, state.settings.strategy),
    totalRequired,
    shortfall,
    surplus: shortfall > 0 ? 0 : round2(Math.max(0, cash)),
    overdraftFees: round2(overdraftFees),
    overdraftFeeEvents: feeEvents,
    lateFees: round2(payments.reduce((s, p) => s + p.lateFee, 0)),
    peakOverdraft: round2(peakOverdraft),
    advances: plannedAdvances,
    advanceFees: round2(plannedAdvances.reduce((s, a) => s + a.fee, 0)),
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
        reportDate: debt.reportsToBureau ? addDays(since, bureauReportDays) : null,
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
        reportDate: null,
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

function paymentStatus(ob: Obligation): PlannedPayment['status'] {
  if (!ob.plannedDate) return 'unfunded'
  // Paid by dipping below $0 — the thing to watch, whether or not it's on time
  if ((ob.balanceAfter ?? 0) < 0) return 'overdraft'
  if (ob.autopay) return 'on_time'
  return ob.plannedDate <= ob.dueDate ? 'on_time' : 'late'
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

function maxDate(a: string, b: string): string {
  return a >= b ? a : b
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
