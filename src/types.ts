export type DebtType =
  | 'credit_card'
  | 'personal_loan'
  | 'friend_loan'
  | 'rent'
  | 'car_lease'
  | 'other'

export const DEBT_TYPE_LABELS: Record<DebtType, string> = {
  credit_card: 'Credit card',
  personal_loan: 'Personal loan',
  friend_loan: 'Loan from friend',
  rent: 'Rent',
  car_lease: 'Car lease',
  other: 'Other',
}

export interface Debt {
  id: string
  name: string
  type: DebtType
  /** Total amount owed right now */
  balance: number
  /** Annual percentage rate, e.g. 24.99 */
  apr: number
  /** Credit limit (credit cards only) — used for utilization display */
  creditLimit?: number
  /** Fixed monthly installment (loans, rent, lease). */
  installment?: number
  /** User override for the minimum payment; wins over computed minimum */
  minOverride?: number
  /** Day of month payment is due, 1–31 */
  dueDay: number
  pastDue: boolean
  /** Amount currently past due (missed payments) */
  pastDueAmount?: number
  /** ISO date of the missed due date — used to count days toward bureau reporting */
  pastDueSince?: string
  /** Friend loans and some debts never report to credit bureaus */
  reportsToBureau: boolean
  /**
   * Automatically deducted from the bank account on each due date. The planner
   * can't delay these — they leave the account on the due date even if the
   * balance is short (overdraft). Missing/false = manual payment.
   */
  autopay?: boolean
  /** Fee the lender charges when a payment lands after its due date (0/missing = none) */
  lateFee?: number
  notes?: string
}

export interface PayAdvance {
  id: string
  amount: number
  date: string
  note?: string
}

/** A one-off cash event: money coming in (bonus, refund) or going out (repair bill) */
export interface OneTimeEvent {
  id: string
  amount: number
  date: string
  kind: 'in' | 'out'
  note?: string
}

export interface Income {
  /** Net take-home per paycheck before advances */
  payAmount: number
  /** ISO date of the next payday */
  nextPayDate: string
  frequencyDays: number
  /** PayActiv (or similar) advances to be deducted from the next paycheck */
  advances: PayAdvance[]
  /** Groceries and other living costs set aside from every paycheck */
  livingExpenses: number
  /** One-off cash in/out events on specific dates */
  oneTimes: OneTimeEvent[]
}

export type Strategy = 'avalanche' | 'snowball'

export interface Settings {
  /** Current bank balance; may be negative (overdraft) */
  bankBalance: number
  asOfDate: string
  strategy: Strategy
  /** Days past due at which a creditor typically reports to bureaus */
  bureauReportDays: number
  /** How far below $0 the bank lets the account go (0 = never plan to overdraw) */
  overdraftLimit: number
  /** Fee charged once per overdraft episode if the balance is still negative the next night */
  overdraftFee: number
}

export interface AppState {
  debts: Debt[]
  income: Income
  settings: Settings
}

// ---- Planner output ----

export type PlannedStatus =
  | 'on_time' // funded on or before due date
  | 'late' // funded, but after the due date
  | 'unfunded' // no cash available within the planning horizon
  | 'overdraft' // paid on the due date by dipping into overdraft (or autopay overdrawing the account)

export interface PlannedPayment {
  debtId: string
  debtName: string
  amount: number
  /** The date the payment is actually due */
  dueDate: string
  /** The date we can actually pay it, given cash flow. May be after dueDate. */
  plannedDate: string | null
  status: PlannedStatus
  /** Fixed-date automatic deduction: plannedDate always equals dueDate */
  autopay: boolean
  isPastDueCatchUp: boolean
  /** Days until the past-due amount hits the bureau reporting threshold (only for past-due, reporting debts) */
  daysUntilReport?: number
  /** Projected bank balance after making this payment */
  balanceAfter?: number
  /** Late fee the lender will charge because this lands after its due date (0 if none) */
  lateFee: number
}

/** An overdraft fee the bank charges in the simulation */
export interface OverdraftFeeEvent {
  date: string
  amount: number
  balanceAfter: number
}

export interface Payday {
  date: string
  gross: number
  advancesDeducted: number
  livingDeducted: number
  net: number
}

export interface PlanResult {
  payments: PlannedPayment[]
  paydays: Payday[]
  /** One-time cash events that fall inside the planning horizon */
  oneTimes: OneTimeEvent[]
  /** Suggested payoff order of debts under the chosen strategy */
  payoffOrder: { debtId: string; reason: string }[]
  /** Total of all minimums + past-due catch-ups in the horizon */
  totalRequired: number
  /** Cash shortfall in the horizon (0 when everything is funded) */
  shortfall: number
  /** Leftover cash after the horizon's obligations — available for extra principal payments */
  surplus: number
  /** Overdraft fees the bank charges in the horizon (deducted from cash) */
  overdraftFees: number
  overdraftFeeEvents: OverdraftFeeEvent[]
  /** Late fees lenders charge for payments landing after their due date (added to balances, not cash) */
  lateFees: number
  /** Deepest the bank balance goes below $0 in the horizon (0 if it never does) */
  peakOverdraft: number
}
