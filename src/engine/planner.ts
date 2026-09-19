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
import { advanceAvailable, buildPaychecks, periodOf, type Paycheck } from './paychecks'

/** Planning horizon in days (~6 biweekly paychecks) */
export const HORIZON_DAYS = 84

/**
 * What a late payment is assumed to cost when the debt has no late fee set —
 * used only to decide whether a pay-advance fee is worth paying to be on time.
 */
export const LATE_PENALTY = 50

/** Cost of letting a past-due account reach the bureau-reporting date */
const BUREAU_PENALTY = 1_000_000

/** How many rounds of "add the single best advance" to try, and how many urgent payments to consider per round */
const MAX_ADVANCE_ROUNDS = 14
const MAX_CANDIDATES = 4
/** How many needy payments the second (chain) search draws its candidate days from */
const MAX_BACKWARD_PAYMENTS = 10
/** How many times the chain search re-expands its candidate days from the plan it just found */
const MAX_CHAIN_PASSES = 3

/** Paid after the safety-margin deadline but still before the bureau report date: a risk, not a report */
const SAFETY_PENALTY = 200

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
  /**
   * On a bureau-reporting debt: the payment is heading for a report if it isn't paid in
   * time — a past-due catch-up, or a regular payment that slips 30 days late. Worth
   * borrowing for as its report date nears.
   */
  bureauCritical: boolean
  /** The day the creditor would report this payment as 30 days late (due/missed date + report days) */
  reportDate: string | null
  /** Last safe day to pay it before that report (report date - 1 - safety margin), never before today */
  hardDeadline: string | null
  /** Its report date is past the end of the plan, so being unpaid at the end isn't a report yet */
  beyondHorizon: boolean
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
  /** The least an advance would have to add for the overdraft room to cover the rest */
  shortMin?: number
  /** The same two numbers, measured when it was already heading for a report (the last safe stretch) */
  shortByHard?: number
  shortMinHard?: number
  /** For a catch-up that can't be saved: extra money it would take, if nothing else were paid */
  bureauGap?: number
}

/** A pay advance the planner is considering / has decided to take */
interface AdvanceReq {
  requestDate: string
  amount: number
  forDebts: string[]
}

interface Ctx {
  /** Finished simulations by the set of advances they were run with (results are never modified) */
  simCache: Map<string, Sim>
  /** Every payment in the plan, in priority order, built once; each simulation works on copies */
  template: Obligation[]
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
    simCache: new Map(),
    template: sortedObligations(state, today, horizonEnd),
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
    const baseSim = sim
    for (let round = 0; round < MAX_ADVANCE_ROUNDS; round++) {
      const better = improveWithAdvance(ctx, advances, sim)
      if (!better) break
      advances = better.advances
      sim = better.sim
    }
    // Also try the chain approach (start with everything, remove what doesn't help)
    // and keep whichever plan is better.
    let chain = backwardAdvances(ctx, baseSim)
    // Taking advances shrinks later paychecks, which can leave new payments short: look
    // again from the plan we ended up with, until it stops improving.
    for (let pass = 0; chain && pass < MAX_CHAIN_PASSES; pass++) {
      const more = backwardAdvances(ctx, chain.sim, chain.advances)
      if (!more || score(ctx, more.sim, more.advances) >= score(ctx, chain.sim, chain.advances) - 1e-6) break
      chain = more
    }
    if (chain && score(ctx, chain.sim, chain.advances) < score(ctx, sim, advances)) {
      advances = chain.advances
      sim = chain.sim
      // the chain can still leave a gap one more advance would close
      for (let round = 0; round < MAX_ADVANCE_ROUNDS; round++) {
        const better = improveWithAdvance(ctx, advances, sim)
        if (!better) break
        advances = better.advances
        sim = better.sim
      }
    }
    ;({ advances, sim } = pruneAdvances(ctx, advances, sim))
    ;({ advances, sim } = shrinkAdvances(ctx, advances, sim))
    // Shrinking frees up room in each pay period's limit, which the first search can
    // now use on other days (a chain that grabbed a whole limit on one day, say).
    let polished = false
    for (let round = 0; round < MAX_ADVANCE_ROUNDS; round++) {
      const better = improveWithAdvance(ctx, advances, sim)
      if (!better) break
      advances = better.advances
      sim = better.sim
      polished = true
    }
    if (polished) {
      ;({ advances, sim } = pruneAdvances(ctx, advances, sim))
      ;({ advances, sim } = shrinkAdvances(ctx, advances, sim))
    }
    const before = advances.length
    ;({ advances, sim } = consolidateAdvances(ctx, advances, sim))
    if (advances.length < before) ({ advances, sim } = shrinkAdvances(ctx, advances, sim))

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

/**
 * Every payment in the plan, in the order money should go to them: 1) anything that can be
 * reported to the bureaus, by the date it would be reported; 2) other past-due accounts;
 * 3) everything else by due date.
 */
function sortedObligations(state: AppState, today: string, horizonEnd: string): Obligation[] {
  const obligations = buildObligations(
    state.debts,
    state.settings.bureauReportDays,
    state.settings.bureauSafetyDays ?? 2,
    today,
    horizonEnd,
  )
  const tier = (o: Obligation) => (o.reportDate !== null ? 0 : o.isPastDueCatchUp ? 1 : 2)
  return obligations.sort((a, b) => {
    if (tier(a) !== tier(b)) return tier(a) - tier(b)
    if (tier(a) === 0 && a.reportDate !== b.reportDate) {
      return (a.reportDate as string).localeCompare(b.reportDate as string)
    }
    if (a.isPastDueCatchUp !== b.isPastDueCatchUp) return a.isPastDueCatchUp ? -1 : 1
    return a.dueDate.localeCompare(b.dueDate)
  })
}

// ---------------------------------------------------------------------------
// Cash simulation
// ---------------------------------------------------------------------------

function simulate(ctx: Ctx, advances: AdvanceReq[]): Sim {
  // the searches keep re-trying the same sets of advances (labels don't affect the result)
  const key = advances
    .map((a) => `${a.requestDate}:${a.amount}`)
    .sort()
    .join(',')
  const cached = ctx.simCache.get(key)
  if (cached) return cached
  const result = runSimulation(ctx, advances)
  ctx.simCache.set(key, result)
  return result
}

function runSimulation(ctx: Ctx, advances: AdvanceReq[]): Sim {
  const { state, today, horizonEnd, overdraftLimit, overdraftFee } = ctx
  const obligations = ctx.template.map((o) => ({ ...o }))

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

  // the day's payment order only changes when something is paid or a catch-up stops being savable
  let orderDirty = true
  const fund = (ob: Obligation, d: string) => {
    ob.plannedDate = d
    cash -= ob.amount
    ob.balanceAfter = round2(cash)
    orderDirty = true
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
  // Order in which unpaid bureau-critical catch-ups need their money
  const criticalOrder = obligations
    .filter((o) => o.bureauCritical && !o.autopay)
    .map((o, i) => ({ o, i }))
    .sort((a, b) => (a.o.hardDeadline ?? '').localeCompare(b.o.hardDeadline ?? '') || a.i - b.i)
    .map((x) => x.o)

  // For each catch-up, from each day on: the most forced money (paydays etc.) that
  // has landed on any day it can still be paid before it's reported. A payday
  // before the report date counts. -Infinity = it can no longer be saved.
  const bestAhead = new Map<Obligation, number[]>()
  for (const y of criticalOrder) {
    const lastDay = y.reportDate ? addDays(y.reportDate, -1) : horizonEnd
    const endI = lastDay < today ? -1 : (dayIndex.get(lastDay > horizonEnd ? horizonEnd : lastDay) ?? -1)
    const best = new Array<number>(days.length).fill(-Infinity)
    let run = -Infinity
    for (let i = days.length - 1; i >= 0; i--) {
      if (i <= endI) run = Math.max(run, cumFlow[i])
      best[i] = run
    }
    bestAhead.set(y, best)
  }
  // Pay advances the plan could still take before each catch-up's last day: every
  // pay period offers what's left of its limit. Counting them (not just the ones
  // already decided) is what keeps money held back for a catch-up that an advance
  // will rescue — otherwise a bill paid today makes the advance pointless tomorrow.
  const lead = state.advance.leadDays
  const advPotential = new Map<Obligation, number[]>()
  if (state.advance.enabled) {
    // many payments share the same period ends, so what's available on a day is worked out once
    const availableByDay = new Map<string, number>()
    const availableFloor = (d: string) => {
      let v = availableByDay.get(d)
      if (v === undefined) {
        v = Math.floor(availableOn(ctx, advances, d))
        availableByDay.set(d, v)
      }
      return v
    }
    const lastPeriodEnd = ctx.paychecks[ctx.paychecks.length - 1]?.periodEnd ?? ''
    const potentialByLatest = new Map<string, number[]>()
    for (const y of criticalOrder) {
      const lastDay = y.reportDate ? addDays(y.reportDate, -1) : horizonEnd
      const latest = addDays(lastDay, -lead)
      // past the last known pay period every payment sees the same thing
      const shareKey = latest > lastPeriodEnd ? 'end' : latest
      const shared = potentialByLatest.get(shareKey)
      if (shared) {
        advPotential.set(y, shared)
        continue
      }
      const parts: { d: string; amount: number }[] = []
      for (const p of ctx.paychecks) {
        const d = latest < p.periodEnd ? latest : p.periodEnd
        if (d < today || d < p.periodStart) continue
        const amount = availableFloor(d)
        if (amount >= 1) parts.push({ d, amount })
      }
      // potential[i] = what the periods whose last useful day is on/after day i can still give
      parts.sort((a, b) => a.d.localeCompare(b.d))
      let remaining = parts.reduce((sum, part) => sum + part.amount, 0)
      let next = 0
      const potential = days.map((day) => {
        while (next < parts.length && parts[next].d < day) remaining -= parts[next++].amount
        return remaining
      })
      potentialByLatest.set(shareKey, potential)
      advPotential.set(y, potential)
    }
  }

  /** Is this catch-up still unpaid with a chance to beat its bureau report? */
  const savableOn = (o: Obligation, dayI: number) =>
    !o.plannedDate && (bestAhead.get(o)?.[dayI] ?? -Infinity) !== -Infinity
  const priority = new Map(obligations.map((o, i) => [o, i]))

  /**
   * Would paying `x` today still leave enough (cash + inflows before the last
   * day it can beat its report + overdraft room) for every more urgent
   * bureau-critical catch-up that could be paid at all? Otherwise the overdraft
   * room and cash get eaten by bills that only cost a late fee while an account
   * heads for the bureaus. Accounts that can't be saved (or are already
   * reported) don't hold anything back.
   */
  // room = balance + inflows (+ advances still possible) + overdraft. Using overdraft may
  // cost a fee — unless this overdraft episode has already been charged.
  const roomOf = (balance: number, flows: number, need: number) =>
    balance + flows + overdraftLimit - (balance + flows < need && negDays < 2 ? overdraftFee : 0)

  const roomForBureau = (x: Obligation, from: string): boolean => {
    const fromI = dayIndex.get(from) ?? 0
    const xSavable = savableOn(x, fromI) // if x is itself heading for a report, only more urgent ones matter
    let committed = 0
    for (const y of criticalOrder) {
      if (y === x) {
        if (xSavable) break
        continue
      }
      const best = bestAhead.get(y)?.[fromI] ?? -Infinity
      if (y.plannedDate || best === -Infinity) continue
      const flows = best - cumFlow[fromI] + (advPotential.get(y)?.[fromI] ?? 0)
      const need = committed + y.amount
      const roomNow = roomOf(cash, flows, need)
      if (need > roomNow) {
        // can't be paid anyway: remember how far short it is, assuming nothing else is paid
        y.bureauGap ??= Math.ceil(need - roomNow)
        continue
      }
      committed = need
      if (roomOf(cash - x.amount, flows, committed) < committed) return false
    }
    return true
  }

  // days on which a catch-up stops being savable just by time passing
  const flipDays = new Set<number>()
  for (const y of criticalOrder) {
    const best = bestAhead.get(y) as number[]
    for (let i = 1; i < best.length; i++) if (best[i] === -Infinity && best[i - 1] !== -Infinity) flipDays.add(i)
  }
  let ordered: Obligation[] = obligations

  while (day <= horizonEnd) {
    cash += paydayByDate.get(day) ?? 0
    cash += oneTimeByDate.get(day) ?? 0
    cash += arrivalByDate.get(day) ?? 0
    for (const ob of autopays) {
      if (ob.dueDate === day) fund(ob, day)
    }
    const reserve = autopayReserve(day)
    // Catch-ups that can still be saved from the bureaus go first; one that has
    // already been reported no longer outranks them for the day's money.
    const dayI = dayIndex.get(day) ?? 0
    if (orderDirty || flipDays.has(dayI)) {
      ordered = [...obligations].sort(
        (a, b) =>
          Number(!savableOn(a, dayI)) - Number(!savableOn(b, dayI)) ||
          (priority.get(a) ?? 0) - (priority.get(b) ?? 0),
      )
      orderDirty = false
    }
    for (const ob of ordered) {
      if (ob.autopay || ob.plannedDate) continue
      if (day < ob.payableFrom) continue
      const affordable = cash - reserve >= ob.amount
      if (affordable && roomForBureau(ob, day)) {
        fund(ob, day)
        continue
      }
      // Not paid from cash: either it can't cover it, or the cash is being held
      // for a payment heading for the bureaus. Is this a day to borrow for it?
      //  - its normal deadline: a regular payment on its due date; a past-due catch-up on
      //    every day from its deadline on
      //  - the last safe stretch before it would be reported (any payment on a reporting debt)
      const soft = ob.deadline
      const inReportWindow =
        ob.hardDeadline !== null && ob.reportDate !== null && day >= ob.hardDeadline && day < ob.reportDate
      const atSoft = soft !== null && (ob.isPastDueCatchUp ? day >= soft : day === soft)
      if (!atSoft && !inReportWindow) continue
      // "bureau mode": worth a fee to avoid a report
      const bureauMode = (ob.isPastDueCatchUp && ob.bureauCritical) || inReportWindow
      // A payment about to be reported beats the autopay hold-back: if the cash is
      // there, use it (a later autopay may then overdraw, which the plan flags).
      if (bureauMode && cash >= ob.amount && roomForBureau(ob, day)) {
        fund(ob, day)
        continue
      }
      // held-back cash means a pay advance would have to cover the whole payment
      const missing = affordable ? ob.amount : ob.amount - (cash - reserve)
      const missingMin = ob.amount - (cash - reserve + overdraftLimit)
      if (ob.shortBy === undefined) {
        ob.shortBy = missing
        ob.shortMin = missingMin
      }
      if (bureauMode && ob.shortByHard === undefined) {
        ob.shortByHard = missing
        ob.shortMinHard = missingMin
      }
      if (overdraftLimit <= 0) continue
      const after = cash - ob.amount
      const extraFee = feeExpected(day, after) && !feeExpected(day, cash) ? overdraftFee : 0
      // Same rule for overdraft room: honour the autopay hold-back unless that would
      // leave a payment headed for the bureaus unpaid.
      const holdBack = bureauMode && after - reserve - extraFee < -overdraftLimit ? 0 : reserve
      const withinLimit = after - holdBack - extraFee >= -overdraftLimit
      const worthIt = bureauMode || extraFee === 0 || ob.lateFee > extraFee
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

/** Paid too late to avoid its penalty (late fee / bureau report)? */
function missed(ob: Obligation): boolean {
  if (ob.isPastDueCatchUp) {
    return ob.bureauCritical && (!ob.plannedDate || ob.plannedDate > (ob.deadline ?? ob.dueDate))
  }
  return !ob.plannedDate || ob.plannedDate > ob.dueDate
}

/**
 * What a past-due account costs: a bureau report if it isn't paid before its report
 * date (and when not everything can be saved, the one reported first is the one to
 * save), or a small penalty for cutting it inside the safety margin.
 */
function bureauCost(ctx: Ctx, ob: Obligation): number {
  if (!ob.reportDate) return 0
  if (missesBureau(ob)) {
    const daysAway = Math.max(0, daysBetween(ctx.today, ob.reportDate))
    return BUREAU_PENALTY + Math.max(0, HORIZON_DAYS - daysAway) * 10
  }
  return ob.plannedDate && ob.hardDeadline && ob.plannedDate > ob.hardDeadline ? SAFETY_PENALTY : 0
}

/** Lower is better. Fees are real dollars; a missed payment costs its late fee (or an assumed penalty). */
function score(ctx: Ctx, sim: Sim, advances: AdvanceReq[], withPeak = true): number {
  let s = sim.overdraftFees + advances.length * ctx.state.advance.fee + (withPeak ? sim.peakOverdraft * 0.05 : 0)
  for (const ob of sim.obligations) {
    if (ob.autopay) continue
    // a report, for anything on a reporting debt (a regular payment that slips 30 days late
    // is reported just like a past-due account) ...
    s += bureauCost(ctx, ob)
    // ... and, for regular payments, the cost of being late at all
    if (!ob.isPastDueCatchUp && missed(ob)) s += ob.lateFee > 0 ? ob.lateFee : LATE_PENALTY
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

/**
 * Advance principal already taken in the same pay period as `on`: advances
 * requested earlier (`before`) plus the ones the user recorded, matched to a
 * period by their date. Each period has its own limit, so advances taken in an
 * earlier period don't count even if they haven't been repaid yet.
 */
function outstandingOn(ctx: Ctx, before: AdvanceReq[], on: string): number {
  const period = periodOf(ctx.paychecks, on) ?? ctx.paychecks.find((p) => p.date > on)
  if (!period) return 0
  const inPeriod = (date: string) => periodOf(ctx.paychecks, date)?.date === period.date
  return (
    ctx.state.income.advances.filter((a) => inPeriod(a.date)).reduce((s, a) => s + a.amount, 0) +
    before.filter((b) => inPeriod(b.requestDate)).reduce((s, b) => s + b.amount, 0)
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

/**
 * Fit a set of advances to the employer's limits: in date order, shrink each to what
 * its pay period still allows on that day (dropping ones that no longer fit). Adding
 * an early advance can use up room a later one in the same period had counted on.
 */
function repairAdvances(ctx: Ctx, advances: AdvanceReq[]): AdvanceReq[] {
  const ordered = advances
    .map((a, i) => ({ a, i }))
    .sort((x, y) => x.a.requestDate.localeCompare(y.a.requestDate) || x.i - y.i)
  const kept: AdvanceReq[] = []
  for (const { a } of ordered) {
    if (a.requestDate < ctx.today) continue
    const room = Math.floor(availableOn(ctx, kept, a.requestDate))
    const amount = Math.min(a.amount, room)
    if (amount >= 1) kept.push({ ...a, amount })
  }
  return kept
}

/**
 * The days an advance could be requested for a payment, and how much it would need to
 * add. A payment heading for a report (a past-due catch-up, or one the plan is letting
 * be reported) can use the whole last safe stretch before its report date — a later day
 * may have room the earlier one doesn't (a new pay period's limit). Any other payment
 * only has its due date.
 */
function advanceWindow(ob: Obligation) {
  if (ob.deadline === null) return null
  const heading =
    ob.hardDeadline !== null && ob.reportDate !== null && (ob.isPastDueCatchUp || missesBureau(ob))
  return {
    start: heading ? (ob.hardDeadline as string) : ob.deadline,
    end: heading ? addDays(ob.reportDate as string, -1) : ob.deadline,
    by: heading ? (ob.shortByHard ?? ob.shortBy) : ob.shortBy,
    min: heading ? (ob.shortMinHard ?? ob.shortMin) : ob.shortMin,
  }
}

/** Most urgent first: payments being reported, then the rest of the reporting ones by report date, then the others */
const byUrgency = (a: Obligation, b: Obligation) =>
  Number(missesBureau(b)) - Number(missesBureau(a)) ||
  (a.reportDate ?? '9999').localeCompare(b.reportDate ?? '9999') ||
  (a.deadline ?? '').localeCompare(b.deadline ?? '')

/**
 * One round of the advance search: from the most urgent payments an advance could
 * rescue, generate candidate advances, re-simulate each, and return the single
 * best move — or null when nothing makes the plan better. Payments about to be
 * reported come first; overdraft-fee tweaks are only considered when no account
 * is heading for a report, and taking the *best* move (not the first) keeps a
 * small fee saving from using up the limit an account needs.
 */
function improveWithAdvance(
  ctx: Ctx,
  advances: AdvanceReq[],
  sim: Sim,
): { advances: AdvanceReq[]; sim: Sim } | null {
  const lead = ctx.state.advance.leadDays
  const base = score(ctx, sim, advances)

  const all = sim.obligations
    .map((ob, i) => ({ ob, i }))
    .filter(({ ob }) => needsAdvance(ob, sim))
    .sort((a, b) => byUrgency(a.ob, b.ob) || a.i - b.i)
  const missedFirst = all.filter(({ ob }) => missed(ob))
  const candidates = (missedFirst.length > 0 ? missedFirst : all).slice(0, MAX_CANDIDATES)

  let best: { advances: AdvanceReq[]; sim: Sim; score: number } | null = null
  for (const { ob } of candidates) {
    const w = advanceWindow(ob)
    if (!w || w.by === undefined) continue
    const deadline = w.start
    const need = Math.ceil(w.by)
    if (need <= 0 || addDays(deadline, -lead) < ctx.today) continue
    const lastDay = w.end
    const options: AdvanceReq[][] = []

    // Two sizes: everything missing (clears any overdraft too), or the least that lets
    // the overdraft room cover the rest — which leaves more of the limit for others.
    const sizes = [...new Set([Math.ceil(w.min ?? need), need].filter((n) => n >= 1))]

    // Top up an advance that's already out and still unpaid on this deadline:
    // one fee instead of two.
    advances.forEach((a, idx) => {
      const repay = repayDateFor(ctx, a)
      const arrives = addDays(a.requestDate, lead)
      if (arrives <= deadline && (repay === null || repay > deadline)) {
        for (const size of sizes) {
          const next = advances.map((x, j) =>
            j === idx ? { ...x, amount: x.amount + size, forDebts: [...x.forDebts, ob.debtName] } : x,
          )
          options.push(repairAdvances(ctx, next))
        }
      }
    })
    // A new advance, trimmed to what's available on the day it's requested. Only advances
    // requested by then count against that day (a later one doesn't block an earlier one;
    // repairAdvances shrinks the later ones to fit).
    for (let arrive = deadline; arrive <= lastDay; arrive = addDays(arrive, 1)) {
      const request = addDays(arrive, -lead)
      if (request < ctx.today) continue
      const room = Math.floor(
        availableOn(ctx, advances.filter((a) => a.requestDate <= request), request),
      )
      for (const amount of new Set(sizes.map((size) => Math.min(size, room)))) {
        if (amount < 1) continue
        const next = [...advances, { requestDate: request, amount, forDebts: [ob.debtName] }]
        options.push(repairAdvances(ctx, next))
      }
    }
    // One advance often isn't enough (each pay period only offers so much), so also try
    // taking what each pay period can give, on the latest day of each.
    for (const target of sizes) {
      const combined: AdvanceReq[] = []
      let remaining = target
      for (const p of ctx.paychecks) {
        const latest = addDays(lastDay, -lead)
        const request = latest < p.periodEnd ? latest : p.periodEnd
        if (request < ctx.today || request < p.periodStart) continue
        const room = Math.floor(
          availableOn(
            ctx,
            [...advances, ...combined].filter((a) => a.requestDate <= request),
            request,
          ),
        )
        const amount = Math.min(remaining, room)
        if (amount >= 1) {
          combined.push({ requestDate: request, amount, forDebts: [ob.debtName] })
          remaining -= amount
        }
        if (remaining <= 0) break
      }
      if (combined.length > 1) options.push(repairAdvances(ctx, [...advances, ...combined]))
    }

    for (const next of options) {
      const nextSim = simulate(ctx, next)
      const nextScore = score(ctx, nextSim, next)
      if (nextScore < base - 1e-6 && (!best || nextScore < best.score)) {
        best = { advances: next, sim: nextSim, score: nextScore }
      }
    }
  }
  return best
}

/**
 * Take the most each pay period allows on each of the given days (in date order).
 * `for` records which payment a day was added for.
 */
function fillAdvances(ctx: Ctx, days: Map<string, string[]>): AdvanceReq[] {
  const out: AdvanceReq[] = []
  for (const day of [...days.keys()].sort()) {
    if (day < ctx.today) continue
    const amount = Math.floor(availableOn(ctx, out, day))
    if (amount >= 1) out.push({ requestDate: day, amount, forDebts: days.get(day) ?? [] })
  }
  return out
}

/**
 * Second search, the mirror of the first: start from taking the most on every day a
 * payment is short, then drop days one at a time while the plan doesn't get worse.
 * Advances often only pay off as a chain — each one funds the paycheck the previous
 * one shrank — so any *partial* chain can look worse than none, and adding one at a
 * time never finds it. Removing from the full chain does.
 */
function backwardAdvances(
  ctx: Ctx,
  sim: Sim,
  seed: AdvanceReq[] = [],
): { advances: AdvanceReq[]; sim: Sim } | null {
  const lead = ctx.state.advance.leadDays
  // every day a payment headed for the bureaus (or otherwise short) could use an advance:
  // from its deadline to the last day it can wait
  const needy = sim.obligations
    .filter(
      (ob) =>
        needsAdvance(ob, sim) ||
        (ob.isPastDueCatchUp && ob.bureauCritical && !ob.autopay && ob.deadline !== null),
    )
    .sort(byUrgency)
    .slice(0, MAX_BACKWARD_PAYMENTS)
  const days = new Map<string, string[]>()
  for (const a of seed) days.set(a.requestDate, [...a.forDebts])
  for (const ob of needy) {
    const w = advanceWindow(ob)
    if (!w) continue
    for (let arrive = w.start; arrive <= w.end; arrive = addDays(arrive, 1)) {
      const request = addDays(arrive, -lead)
      if (request >= ctx.today) days.set(request, [...(days.get(request) ?? []), ob.debtName])
    }
  }
  if (days.size === 0) return null

  const evaluate = (set: Map<string, string[]>) => {
    const advances = fillAdvances(ctx, set)
    const s = simulate(ctx, advances)
    return { advances, sim: s, score: score(ctx, s, advances) }
  }
  let current = evaluate(days)
  const remaining = new Map(days)
  // one pass tries dropping each day; keep dropping while a pass removes something
  let removed = true
  while (removed && remaining.size > 1) {
    removed = false
    for (const day of [...remaining.keys()].sort()) {
      if (remaining.size <= 1) break
      const without = new Map(remaining)
      without.delete(day)
      const trial = evaluate(without)
      if (trial.score <= current.score + 1e-6) {
        current = trial
        remaining.delete(day)
        removed = true
      }
    }
  }
  return { advances: current.advances, sim: current.sim }
}

/**
 * The searches take whatever an advance allows; borrow only what's needed. For each
 * advance, find the smallest amount that leaves the plan just as good (same fees,
 * same payments on time) — no reason to shrink next paycheck by more than that.
 */
function shrinkAdvances(
  ctx: Ctx,
  advances: AdvanceReq[],
  sim: Sim,
): { advances: AdvanceReq[]; sim: Sim } {
  let current = { advances, sim }
  const target = score(ctx, sim, advances, false)
  for (let i = 0; i < current.advances.length; i++) {
    let lo = 1
    let hi = current.advances[i].amount
    let best = { advances: current.advances, sim: current.sim }
    // within $2 is close enough: every step below is another full simulation
    while (hi - lo > 2) {
      const mid = Math.floor((lo + hi) / 2)
      const trial = current.advances.map((a, j) => (j === i ? { ...a, amount: mid } : a))
      const trialSim = simulate(ctx, trial)
      if (score(ctx, trialSim, trial, false) <= target + 1e-6) {
        best = { advances: trial, sim: trialSim }
        hi = mid
      } else {
        lo = mid + 1
      }
    }
    current = best
  }
  return current
}

/**
 * Advances that come out of the same paycheck don't each need their own transfer (and
 * $3 fee): where one advance can take on another's amount and the plan is no worse,
 * merge them. The searches add advances a day at a time as needs come up, so this is
 * what turns "Sep 23 + Sep 24" into a single Sep 24 advance.
 */
function consolidateAdvances(
  ctx: Ctx,
  advances: AdvanceReq[],
  sim: Sim,
): { advances: AdvanceReq[]; sim: Sim } {
  if (ctx.state.advance.fee <= 0) return { advances, sim } // nothing to save
  let current = { advances, sim }
  let merged = true
  while (merged && current.advances.length > 1) {
    merged = false
    const list = current.advances
    const base = score(ctx, current.sim, list, false)
    search: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (repayDateFor(ctx, list[i]) !== repayDateFor(ctx, list[j])) continue
        // fold the earlier into the later first (money later, more accrued room), then the other way
        for (const [keep, drop] of [
          [j, i],
          [i, j],
        ]) {
          const next = list
            .filter((_, k) => k !== drop)
            .map((a) =>
              a === list[keep]
                ? { ...a, amount: a.amount + list[drop].amount, forDebts: [...a.forDebts, ...list[drop].forDebts] }
                : a,
            )
          const fitted = repairAdvances(ctx, next)
          if (fitted.length !== next.length) continue // the merged amount doesn't fit the limit
          const trialSim = simulate(ctx, fitted)
          if (score(ctx, trialSim, fitted, false) < base - 1e-6) {
            current = { advances: fitted, sim: trialSim }
            merged = true
            break search
          }
        }
      }
    }
  }
  return current
}

/** Drop any advance the plan does better without (an earlier move can make a later one pointless). */
function pruneAdvances(
  ctx: Ctx,
  advances: AdvanceReq[],
  sim: Sim,
): { advances: AdvanceReq[]; sim: Sim } {
  let current = { advances, sim }
  let improved = true
  while (improved && current.advances.length > 0) {
    improved = false
    const base = score(ctx, current.sim, current.advances)
    for (let i = current.advances.length - 1; i >= 0; i--) {
      const without = current.advances.filter((_, j) => j !== i)
      const withoutSim = simulate(ctx, without)
      if (score(ctx, withoutSim, without) <= base - 1e-6) {
        current = { advances: without, sim: withoutSim }
        improved = true
        break
      }
    }
  }
  return current
}

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

function toResult(ctx: Ctx, sim: Sim, advances: AdvanceReq[]): PlanResult {
  const { state, overdraftLimit } = ctx
  const { obligations, paydays, cash, overdraftFees, feeEvents, peakOverdraft } = sim
  const adv = state.advance

  // Label each advance with the payments that would be paid later (or not at all) without
  // it — what it really pays for, rather than which search step happened to add it.
  const keyOf = (o: Obligation) => `${o.debtId}|${o.dueDate}|${o.isPastDueCatchUp}`
  const plannedOn = new Map(obligations.map((o) => [keyOf(o), o.plannedDate ?? '9999-12-31']))
  const labelFor = (a: AdvanceReq): string[] => {
    // Only payments made while the advance is outstanding (arrival until the paycheck that
    // repays it): later ones change only because the repayment shrinks that paycheck.
    const from = addDays(a.requestDate, adv.leadDays)
    const to = repayDateFor(ctx, a) ?? '9999-12-31'
    const without = simulate(ctx, advances.filter((x) => x !== a))
    return [
      ...new Set(
        without.obligations
          .filter((o) => {
            const paid = plannedOn.get(keyOf(o)) ?? ''
            return !o.autopay && paid >= from && paid < to && (o.plannedDate ?? '9999-12-31') > paid
          })
          .map((o) => o.debtName),
      ),
    ]
  }

  const plannedAdvances: PlannedAdvance[] = advances
    .map((a) => ({
      requestDate: a.requestDate,
      arrivalDate: addDays(a.requestDate, adv.leadDays),
      amount: a.amount,
      fee: adv.fee,
      repayDate: repayDateFor(ctx, a),
      forDebts: labelFor(a),
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
    missesBureau: missesBureau(ob),
    bureauGap: missesBureau(ob) ? ob.bureauGap : undefined,
    // the bills being paid with the money that's left while this one heads for the bureaus
    bureauPaidFirst: missesBureau(ob)
      ? [
          ...new Set(
            obligations
              .filter(
                (o) =>
                  !o.autopay &&
                  !o.isPastDueCatchUp &&
                  o.plannedDate &&
                  o.plannedDate <= (ob.hardDeadline ?? ob.deadline ?? ob.dueDate),
              )
              .map((o) => o.debtName),
          ),
        ]
      : undefined,
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
  safetyDays: number,
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
        // pay `safetyDays` before the report date so the payment posts in time
        deadline: debt.reportsToBureau
          ? maxDate(today, addDays(since, bureauReportDays - 1 - safetyDays))
          : null,
        bureauCritical: debt.reportsToBureau,
        reportDate: debt.reportsToBureau ? addDays(since, bureauReportDays) : null,
        hardDeadline: debt.reportsToBureau
          ? maxDate(today, addDays(since, bureauReportDays - 1 - safetyDays))
          : null,
        beyondHorizon: debt.reportsToBureau ? addDays(since, bureauReportDays) > horizonEnd : false,
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
        // a regular payment on a reporting debt is reported if it slips 30 days past its due date
        bureauCritical: debt.reportsToBureau,
        reportDate: debt.reportsToBureau ? addDays(due, bureauReportDays) : null,
        hardDeadline: debt.reportsToBureau
          ? maxDate(today, addDays(due, bureauReportDays - 1 - safetyDays))
          : null,
        beyondHorizon: debt.reportsToBureau ? addDays(due, bureauReportDays) > horizonEnd : false,
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

/** A past-due catch-up that isn't paid before its report date */
function missesBureau(ob: Obligation): boolean {
  if (!ob.bureauCritical || ob.reportDate === null) return false
  if (!ob.plannedDate) return !ob.beyondHorizon // unpaid at the end of the plan, and reported by then
  return ob.plannedDate >= ob.reportDate
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
