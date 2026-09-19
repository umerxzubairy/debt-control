import { useEffect, useReducer } from 'react'
import type {
  AdvanceSettings,
  AppState,
  Debt,
  Income,
  OneTimeEvent,
  PayAdvance,
  Settings,
} from './types'
import { todayISO } from './engine/dates'

const STORAGE_KEY = 'debt-control-v1'

export const initialState: AppState = {
  debts: [],
  income: {
    payAmount: 0,
    scheduleKind: 'interval',
    nextPayDate: todayISO(),
    frequencyDays: 14,
    periodLagDays: 7,
    monthlyPaychecks: [],
    advances: [],
    livingExpenses: 0,
    oneTimes: [],
  },
  advance: {
    enabled: false,
    // $3 flat fee, money arrives instantly, up to half a paycheck per pay period
    fee: 3,
    leadDays: 0,
    maxPercent: 50,
    limitToEarned: false,
  },
  settings: {
    bankBalance: 0,
    asOfDate: todayISO(),
    strategy: 'avalanche',
    bureauReportDays: 30,
    bureauSafetyDays: 2,
    overdraftLimit: 0,
    overdraftFee: 0,
  },
}

export type Action =
  | { type: 'addDebt'; debt: Debt }
  | { type: 'updateDebt'; debt: Debt }
  | { type: 'removeDebt'; id: string }
  | { type: 'recordPayment'; debtId: string; amount: number }
  | { type: 'setIncome'; income: Income }
  | { type: 'addAdvance'; advance: PayAdvance }
  | { type: 'removeAdvance'; id: string }
  | { type: 'addOneTime'; event: OneTimeEvent }
  | { type: 'removeOneTime'; id: string }
  | { type: 'setSettings'; settings: Settings }
  | { type: 'setAdvance'; advance: AdvanceSettings }
  | { type: 'importState'; state: AppState }

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'addDebt':
      return { ...state, debts: [...state.debts, action.debt] }
    case 'updateDebt':
      return {
        ...state,
        debts: state.debts.map((d) => (d.id === action.debt.id ? action.debt : d)),
      }
    case 'removeDebt':
      return { ...state, debts: state.debts.filter((d) => d.id !== action.id) }
    case 'recordPayment': {
      const debts = state.debts.map((d) => {
        if (d.id !== action.debtId) return d
        const pastDueLeft = Math.max(0, (d.pastDueAmount ?? 0) - action.amount)
        return {
          ...d,
          balance: Math.max(0, d.balance - action.amount),
          pastDue: d.pastDue && pastDueLeft > 0,
          pastDueAmount: pastDueLeft > 0 ? pastDueLeft : undefined,
          pastDueSince: pastDueLeft > 0 ? d.pastDueSince : undefined,
        }
      })
      return {
        ...state,
        debts,
        settings: {
          ...state.settings,
          bankBalance: Math.round((state.settings.bankBalance - action.amount) * 100) / 100,
        },
      }
    }
    case 'setIncome':
      return { ...state, income: action.income }
    case 'addAdvance':
      return {
        ...state,
        income: { ...state.income, advances: [...state.income.advances, action.advance] },
      }
    case 'removeAdvance':
      return {
        ...state,
        income: {
          ...state.income,
          advances: state.income.advances.filter((a) => a.id !== action.id),
        },
      }
    case 'addOneTime':
      return {
        ...state,
        income: { ...state.income, oneTimes: [...state.income.oneTimes, action.event] },
      }
    case 'removeOneTime':
      return {
        ...state,
        income: {
          ...state.income,
          oneTimes: state.income.oneTimes.filter((e) => e.id !== action.id),
        },
      }
    case 'setSettings':
      return { ...state, settings: action.settings }
    case 'setAdvance':
      return { ...state, advance: action.advance }
    case 'importState':
      return normalizeState(action.state)
  }
}

/**
 * Fill in defaults for fields added after the data was saved. Used for both
 * localStorage and imported backups, so older data keeps working.
 */
export function normalizeState(parsed: Partial<AppState>): AppState {
  return {
    ...initialState,
    ...parsed,
    income: { ...initialState.income, ...parsed.income },
    settings: { ...initialState.settings, ...parsed.settings },
    advance: { ...initialState.advance, ...migrateAdvance(parsed.advance) },
  }
}

/** Drop settings saved by the first version of the pay-advance model. */
function migrateAdvance(saved?: Partial<AdvanceSettings> & { maxOutstanding?: number }) {
  if (!saved) return {}
  const { maxOutstanding, ...rest } = saved
  // That version guessed a $3.49 fee and a $500 cap. Only an untouched old default is
  // replaced; the real setup is a $3 fee with a per-pay-period limit.
  if (maxOutstanding !== undefined && rest.fee === 3.49) delete rest.fee
  return rest
}

function load(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return initialState
    return normalizeState(JSON.parse(raw) as Partial<AppState>)
  } catch {
    return initialState
  }
}

export function useAppState() {
  const [state, dispatch] = useReducer(reducer, undefined, load)
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }, [state])
  return { state, dispatch }
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10)
}
