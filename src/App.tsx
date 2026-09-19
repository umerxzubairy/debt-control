import { useMemo, useState } from 'react'
import { useAppState } from './store'
import { buildPlan } from './engine/planner'
import { cycleMinimum } from './engine/minPayment'
import { fmtMoney } from './format'
import { fmtDateShort } from './engine/dates'
import Board from './components/Board'
import Schedule from './components/Schedule'
import Debts from './components/Debts'
import IncomePanel from './components/IncomePanel'

type Tab = 'board' | 'schedule' | 'debts' | 'income'

const TABS: { id: Tab; label: string }[] = [
  { id: 'board', label: 'Board' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'debts', label: 'Debts' },
  { id: 'income', label: 'Income & Balance' },
]

export default function App() {
  const { state, dispatch } = useAppState()
  const [tab, setTab] = useState<Tab>(state.debts.length === 0 ? 'income' : 'board')
  const plan = useMemo(() => buildPlan(state), [state])

  const totalDebt = state.debts.reduce((s, d) => s + d.balance, 0)
  const nextPayday = plan.paydays[0]

  // how much further below $0 the bank will still let the account go right now
  const overdraftLimit = state.settings.overdraftLimit ?? 0
  const overdraftRoom = Math.max(0, overdraftLimit + Math.min(0, state.settings.bankBalance))

  // monthly money in vs. out
  const paychecksPerMonth = 365.25 / state.income.frequencyDays / 12
  const monthlyIncome = state.income.payAmount * paychecksPerMonth
  const monthlyLiving = (state.income.livingExpenses ?? 0) * paychecksPerMonth
  const monthlyMinimums = state.debts
    .filter((d) => d.balance > 0)
    .reduce((s, d) => s + cycleMinimum(d), 0)
  const monthlyLeft = monthlyIncome - monthlyLiving - monthlyMinimums

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          Debt<span className="accent">Control</span>
        </h1>
        <div className="stats">
          <Stat
            label="Bank balance"
            value={fmtMoney(state.settings.bankBalance)}
            tone={state.settings.bankBalance < 0 ? 'bad' : 'good'}
            sub={
              overdraftLimit > 0
                ? `overdraft room ${fmtMoney(overdraftRoom)} of ${fmtMoney(overdraftLimit)}`
                : undefined
            }
          />
          <Stat label="Total debt" value={fmtMoney(totalDebt)} tone="neutral" />
          <Stat
            label="Minimums / month"
            value={fmtMoney(monthlyMinimums)}
            tone={monthlyLeft < 0 ? 'bad' : 'neutral'}
            sub={
              monthlyIncome > 0
                ? `income ${fmtMoney(monthlyIncome)} − living ${fmtMoney(monthlyLiving)} → ${
                    monthlyLeft >= 0 ? 'left' : 'SHORT'
                  } ${fmtMoney(Math.abs(monthlyLeft))}`
                : 'set your salary to compare'
            }
          />
          <Stat
            label="Required (12 wks)"
            value={fmtMoney(plan.totalRequired)}
            tone="neutral"
          />
          {plan.overdraftFees + plan.lateFees > 0 && (
            <Stat
              label="Projected fees (12 wks)"
              value={fmtMoney(plan.overdraftFees + plan.lateFees)}
              tone="bad"
              sub={`overdraft ${fmtMoney(plan.overdraftFees)} · late ${fmtMoney(plan.lateFees)}${
                plan.peakOverdraft > 0 ? ` · peak overdraft ${fmtMoney(plan.peakOverdraft)}` : ''
              }`}
            />
          )}
          {plan.shortfall > 0 ? (
            <Stat label="Shortfall" value={fmtMoney(plan.shortfall)} tone="bad" />
          ) : (
            <Stat label="Surplus for extra payoff" value={fmtMoney(plan.surplus)} tone="good" />
          )}
          <Stat
            label="Next payday"
            value={
              nextPayday
                ? `${fmtDateShort(nextPayday.date)} · ${fmtMoney(nextPayday.net)}`
                : 'not set'
            }
            tone="neutral"
          />
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? 'tab active' : 'tab'}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main>
        {tab === 'board' && <Board state={state} plan={plan} dispatch={dispatch} />}
        {tab === 'schedule' && <Schedule state={state} plan={plan} />}
        {tab === 'debts' && <Debts state={state} dispatch={dispatch} />}
        {tab === 'income' && <IncomePanel state={state} dispatch={dispatch} />}
      </main>

      <footer className="footer">
        <span>
          Open source ·{' '}
          <a
            href="https://github.com/umernaeem217/debt-control"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </span>
        <span className="muted">Your data never leaves this browser.</span>
      </footer>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
  sub,
}: {
  label: string
  value: string
  tone: 'good' | 'bad' | 'neutral'
  sub?: string
}) {
  return (
    <div className={`stat ${tone}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  )
}
