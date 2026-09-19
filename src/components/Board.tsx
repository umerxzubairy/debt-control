import { useState } from 'react'
import type { AppState, Debt, PlanResult, PlannedPayment } from '../types'
import { DEBT_TYPE_LABELS } from '../types'
import type { Action } from '../store'
import { fmtMoney } from '../format'
import { fmtDateShort, todayISO, addDays } from '../engine/dates'
import { requiredNow } from '../engine/minPayment'

type ColumnId = 'report_risk' | 'past_due' | 'needs_money' | 'due_soon' | 'on_track'

const COLUMNS: { id: ColumnId; title: string; hint: string }[] = [
  {
    id: 'report_risk',
    title: '🚨 Bureau report risk',
    hint: 'Past due and close to being reported to credit bureaus — pay these first',
  },
  {
    id: 'past_due',
    title: '⏰ Past due',
    hint: 'Behind on payments, but reporting is not imminent',
  },
  {
    id: 'needs_money',
    title: '💸 Needs more money',
    hint: 'Plan cannot fund these on time — add money or the payment lands late',
  },
  {
    id: 'due_soon',
    title: '📅 Due soon — funded',
    hint: 'Due within 14 days, cash is planned for them on time',
  },
  {
    id: 'on_track',
    title: '✅ On track',
    hint: 'Funded on time later in the plan',
  },
]

export default function Board({
  state,
  plan,
  dispatch,
}: {
  state: AppState
  plan: PlanResult
  dispatch: (a: Action) => void
}) {
  const today = todayISO()
  const soon = addDays(today, 14)

  // next pending payment per debt
  const nextPayment = new Map<string, PlannedPayment>()
  for (const p of plan.payments) {
    if (!nextPayment.has(p.debtId)) nextPayment.set(p.debtId, p)
  }

  function columnFor(debt: Debt): ColumnId {
    const p = nextPayment.get(debt.id)
    if (debt.pastDue && debt.reportsToBureau) {
      const days = p?.daysUntilReport ?? 0
      if (days <= 10) return 'report_risk'
    }
    if (debt.pastDue) return 'past_due'
    if (p && (p.status === 'late' || p.status === 'unfunded' || p.status === 'overdraft')) {
      return 'needs_money'
    }
    if (p && p.dueDate <= soon) return 'due_soon'
    return 'on_track'
  }

  const debtsByColumn = new Map<ColumnId, Debt[]>()
  for (const debt of state.debts.filter((d) => d.balance > 0)) {
    const col = columnFor(debt)
    debtsByColumn.set(col, [...(debtsByColumn.get(col) ?? []), debt])
  }

  const orderIndex = new Map(plan.payoffOrder.map((o, i) => [o.debtId, i]))

  return (
    <div className="board-wrap">
      <PayoffStrategy state={state} plan={plan} dispatch={dispatch} />
      <div className="board">
        {COLUMNS.map((col) => {
          const debts = (debtsByColumn.get(col.id) ?? []).sort(
            (a, b) => (orderIndex.get(a.id) ?? 99) - (orderIndex.get(b.id) ?? 99),
          )
          return (
            <div key={col.id} className={`column col-${col.id}`}>
              <div className="column-head" title={col.hint}>
                <span>{col.title}</span>
                <span className="count">{debts.length}</span>
              </div>
              <p className="column-hint">{col.hint}</p>
              {debts.map((debt) => (
                <DebtCard
                  key={debt.id}
                  debt={debt}
                  payment={nextPayment.get(debt.id)}
                  dispatch={dispatch}
                />
              ))}
              {debts.length === 0 && <div className="empty-col">—</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function DebtCard({
  debt,
  payment,
  dispatch,
}: {
  debt: Debt
  payment?: PlannedPayment
  dispatch: (a: Action) => void
}) {
  const [paying, setPaying] = useState(false)
  const [amount, setAmount] = useState('')
  const required = requiredNow(debt)
  const utilization =
    debt.type === 'credit_card' && debt.creditLimit
      ? Math.min(100, Math.round((debt.balance / debt.creditLimit) * 100))
      : null

  return (
    <div className="card">
      <div className="card-title">
        <strong>{debt.name}</strong>
        <span className="pills">
          {debt.autopay && <span className="pill autopay-pill">autopay</span>}
          <span className="pill">{DEBT_TYPE_LABELS[debt.type]}</span>
        </span>
      </div>
      <div className="card-row">
        <span>Balance</span>
        <strong>{fmtMoney(debt.balance)}</strong>
      </div>
      <div className="card-row">
        <span>Required now</span>
        <strong>{fmtMoney(required)}</strong>
      </div>
      {payment && (
        <div className="card-row">
          <span>Next payment</span>
          <span>
            {fmtMoney(payment.amount)} · due {fmtDateShort(payment.dueDate)}
          </span>
        </div>
      )}
      {payment && (
        <div className="card-row">
          <span>{payment.autopay ? 'Auto-deducted' : 'Can pay on'}</span>
          <span
            className={
              payment.status === 'on_time'
                ? 'ok'
                : payment.status === 'overdraft'
                  ? 'danger'
                  : 'warn'
            }
          >
            {payment.plannedDate ? fmtDateShort(payment.plannedDate) : 'no cash in plan'}
            {payment.status === 'late' && ' (late)'}
            {payment.status === 'overdraft' &&
              (payment.autopay ? ' (overdraft!)' : ' (via overdraft)')}
          </span>
        </div>
      )}
      {payment?.advanceRequestDate && (
        <div className="card-row">
          <span>⚡ Pay advance</span>
          <strong className="ok">request {fmtDateShort(payment.advanceRequestDate)}</strong>
        </div>
      )}
      {payment && payment.lateFee > 0 && (
        <div className="card-row">
          <span>Late fee</span>
          <strong className="warn">{fmtMoney(payment.lateFee)} expected</strong>
        </div>
      )}
      {payment?.daysUntilReport != null && (
        <div className="card-row">
          <span>Bureau report in</span>
          <strong className={payment.daysUntilReport <= 10 ? 'danger' : 'warn'}>
            ~{payment.daysUntilReport} days
          </strong>
        </div>
      )}
      {utilization != null && (
        <div className="util">
          <div className="util-bar">
            <div
              className={`util-fill ${utilization >= 90 ? 'danger-bg' : ''}`}
              style={{ width: `${utilization}%` }}
            />
          </div>
          <span>{utilization}% of limit</span>
        </div>
      )}
      {!paying ? (
        <button className="btn small" onClick={() => setPaying(true)}>
          Record payment
        </button>
      ) : (
        <form
          className="pay-form"
          onSubmit={(e) => {
            e.preventDefault()
            const n = parseFloat(amount)
            if (!isNaN(n) && n > 0) {
              dispatch({ type: 'recordPayment', debtId: debt.id, amount: n })
              setPaying(false)
              setAmount('')
            }
          }}
        >
          <input
            autoFocus
            type="number"
            step="0.01"
            min="0.01"
            placeholder={String(required)}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <button className="btn small" type="submit">
            Pay
          </button>
          <button className="btn small ghost" type="button" onClick={() => setPaying(false)}>
            ✕
          </button>
        </form>
      )}
    </div>
  )
}

function PayoffStrategy({
  state,
  plan,
  dispatch,
}: {
  state: AppState
  plan: PlanResult
  dispatch: (a: Action) => void
}) {
  const byId = new Map(state.debts.map((d) => [d.id, d]))
  return (
    <div className="strategy">
      <div className="strategy-head">
        <strong>Payoff order for extra money</strong>
        <div className="seg">
          {(['avalanche', 'snowball'] as const).map((s) => (
            <button
              key={s}
              className={state.settings.strategy === s ? 'seg-btn active' : 'seg-btn'}
              onClick={() =>
                dispatch({ type: 'setSettings', settings: { ...state.settings, strategy: s } })
              }
            >
              {s === 'avalanche' ? 'Avalanche (highest APR)' : 'Snowball (smallest balance)'}
            </button>
          ))}
        </div>
      </div>
      <ol className="payoff-list">
        {plan.payoffOrder.map((o, i) => {
          const d = byId.get(o.debtId)
          if (!d) return null
          return (
            <li key={o.debtId}>
              <span className="rank">{i + 1}</span>
              <strong>{d.name}</strong>
              <span className="muted">{o.reason}</span>
            </li>
          )
        })}
      </ol>
      {plan.surplus > 0 && plan.payoffOrder.length > 0 && (
        <p className="tip">
          After all minimums and catch-ups, the plan leaves{' '}
          <strong>{fmtMoney(plan.surplus)}</strong> over 12 weeks — put it toward{' '}
          <strong>{byId.get(plan.payoffOrder[0].debtId)?.name}</strong> first.
        </p>
      )}
      {plan.shortfall > 0 && (
        <p className="tip danger">
          The plan is short {fmtMoney(plan.shortfall)} over the next 12 weeks — some payments
          cannot be funded. Prioritize the 🚨 column.
        </p>
      )}
    </div>
  )
}
