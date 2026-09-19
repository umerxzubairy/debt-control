import { useEffect, useReducer } from 'react'
import type { AppState, Debt, Income, OneTimeEvent, PayAdvance, Settings } from './types'
import { todayISO } from './engine/dates'

const STORAGE_KEY = 'debt-control-v1'

export const initialState: AppState = {
  debts: [],
  income: {
    payAmount: 0,
    nextPayDate: todayISO(),
    frequencyDays: 14,
    advances: [],
    livingExpenses: 0,
    oneTimes: [],
  },
  settings: {
    bankBalance: 0,
    asOfDate: todayISO(),
    strategy: 'avalanche',
    bureauReportDays: 30,
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
    case 'importState':
      return action.state
  }
}

function load(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return initialState
    const parsed = JSON.parse(raw) as AppState
    return {
      ...initialState,
      ...parsed,
      income: { ...initialState.income, ...parsed.income },
      settings: { ...initialState.settings, ...parsed.settings },
    }
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
