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

export interface PlannedPayment {
  debtId: string
  debtName: string
  amount: number
  /** The date the payment is actually due */
  dueDate: string
  /** The date we can actually pay it, given cash flow. May be after dueDate. */
  plannedDate: string | null
  status: PlannedStatus
  isPastDueCatchUp: boolean
  /** Days until the past-due amount hits the bureau reporting threshold (only for past-due, reporting debts) */
  daysUntilReport?: number
  /** Projected bank balance after making this payment */
  balanceAfter?: number
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
}
