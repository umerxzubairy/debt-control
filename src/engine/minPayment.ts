import type { Debt } from '../types'

/**
 * Minimum payment for the current cycle, not counting past-due catch-up.
 *
 * Credit cards: issuers typically charge the greater of a floor (~$35) or
 * 1% of balance plus accrued monthly interest. Capped at the balance.
 * Loans / rent / lease: the fixed installment.
 * A user override always wins.
 */
export function cycleMinimum(debt: Debt): number {
  if (debt.minOverride != null && debt.minOverride > 0) {
    return Math.min(debt.minOverride, debt.balance)
  }
  if (debt.type === 'credit_card') {
    if (debt.balance <= 0) return 0
    const monthlyInterest = debt.balance * (debt.apr / 100 / 12)
    const computed = debt.balance * 0.01 + monthlyInterest
    return Math.min(Math.max(35, Math.round(computed)), debt.balance)
  }
  if (debt.installment != null && debt.installment > 0) {
    return Math.min(debt.installment, debt.balance)
  }
  // No installment given: fall back to something sane rather than zero
  if (debt.balance <= 0) return 0
  return Math.min(Math.max(25, Math.round(debt.balance * 0.02)), debt.balance)
}

/**
 * Total required right now: past-due catch-up plus the current cycle minimum.
 */
export function requiredNow(debt: Debt): number {
  const pastDue = debt.pastDue ? (debt.pastDueAmount ?? cycleMinimum(debt)) : 0
  return Math.min(pastDue + cycleMinimum(debt), debt.balance)
}
