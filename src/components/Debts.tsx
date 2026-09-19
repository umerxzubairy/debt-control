import { useState } from 'react'
import type { AppState, Debt, DebtType } from '../types'
import { DEBT_TYPE_LABELS } from '../types'
import type { Action } from '../store'
import { uid } from '../store'
import { fmtMoney } from '../format'
import { cycleMinimum, requiredNow } from '../engine/minPayment'
import { todayISO } from '../engine/dates'

const EMPTY: Omit<Debt, 'id'> = {
  name: '',
  type: 'credit_card',
  balance: 0,
  apr: 0,
  dueDay: 1,
  pastDue: false,
  reportsToBureau: true,
  autopay: false,
}

export default function Debts({
  state,
  dispatch,
}: {
  state: AppState
  dispatch: (a: Action) => void
}) {
  const [editing, setEditing] = useState<Debt | null>(null)
  const [adding, setAdding] = useState(false)

  return (
    <div className="debts">
      {!adding && !editing && (
        <button className="btn primary" onClick={() => setAdding(true)}>
          + Add debt
        </button>
      )}
      {(adding || editing) && (
        <DebtForm
          initial={editing ?? undefined}
          onCancel={() => {
            setAdding(false)
            setEditing(null)
          }}
          onSave={(debt) => {
            dispatch(editing ? { type: 'updateDebt', debt } : { type: 'addDebt', debt })
            setAdding(false)
            setEditing(null)
          }}
        />
      )}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th className="num">Balance</th>
            <th className="num">APR</th>
            <th className="num">Min / cycle</th>
            <th className="num">Required now</th>
            <th>Due day</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {state.debts.map((d) => (
            <tr key={d.id}>
              <td>
                <strong>{d.name}</strong>
                {d.autopay && <span className="pill autopay-pill">autopay</span>}
                {!d.reportsToBureau && <span className="pill">no bureau</span>}
              </td>
              <td>{DEBT_TYPE_LABELS[d.type]}</td>
              <td className="num">{fmtMoney(d.balance)}</td>
              <td className="num">{d.apr ? `${d.apr}%` : '—'}</td>
              <td className="num">
                {fmtMoney(cycleMinimum(d))}
                {d.minOverride != null && d.minOverride > 0 && (
                  <span className="muted"> (set)</span>
                )}
              </td>
              <td className="num">{fmtMoney(requiredNow(d))}</td>
              <td>{d.dueDay}</td>
              <td>
                {d.pastDue ? (
                  <span className="danger">past due {fmtMoney(d.pastDueAmount ?? 0)}</span>
                ) : (
                  <span className="ok">current</span>
                )}
              </td>
              <td className="row-actions">
                <button className="btn small ghost" onClick={() => setEditing(d)}>
                  Edit
                </button>
                <button
                  className="btn small ghost danger"
                  onClick={() => {
                    if (confirm(`Delete ${d.name}?`)) dispatch({ type: 'removeDebt', id: d.id })
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
          {state.debts.length === 0 && (
            <tr>
              <td colSpan={9} className="empty-msg">
                No debts yet. Add each credit card, loan, rent, and lease — including anything
                past due.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function DebtForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Debt
  onSave: (d: Debt) => void
  onCancel: () => void
}) {
  const [d, setD] = useState<Omit<Debt, 'id'>>(initial ?? EMPTY)
  const set = (patch: Partial<Debt>) => setD((prev) => ({ ...prev, ...patch }))
  const preview: Debt = { ...d, id: 'preview' }
  const isCard = d.type === 'credit_card'
  const isInstallment = !isCard

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault()
        if (!d.name.trim() || d.balance <= 0) return
        onSave({ ...d, id: initial?.id ?? uid() })
      }}
    >
      <h3>{initial ? `Edit ${initial.name}` : 'Add debt'}</h3>
      <div className="grid">
        <label>
          Name
          <input
            required
            value={d.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Chase Freedom, Rent, Mom…"
          />
        </label>
        <label>
          Type
          <select
            value={d.type}
            onChange={(e) => {
              const type = e.target.value as DebtType
              set({ type, reportsToBureau: type !== 'friend_loan' && type !== 'rent' })
            }}
          >
            {Object.entries(DEBT_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Total owed ($)
          <input
            required
            type="number"
            step="0.01"
            min="0"
            value={d.balance || ''}
            onChange={(e) => set({ balance: parseFloat(e.target.value) || 0 })}
          />
        </label>
        <label>
          APR (%)
          <input
            type="number"
            step="0.01"
            min="0"
            value={d.apr || ''}
            onChange={(e) => set({ apr: parseFloat(e.target.value) || 0 })}
          />
        </label>
        {isCard && (
          <label>
            Credit limit ($)
            <input
              type="number"
              step="1"
              min="0"
              value={d.creditLimit ?? ''}
              onChange={(e) =>
                set({ creditLimit: e.target.value ? parseFloat(e.target.value) : undefined })
              }
            />
          </label>
        )}
        {isInstallment && (
          <label>
            Monthly payment ($)
            <input
              type="number"
              step="0.01"
              min="0"
              value={d.installment ?? ''}
              onChange={(e) =>
                set({ installment: e.target.value ? parseFloat(e.target.value) : undefined })
              }
            />
          </label>
        )}
        <label>
          Min payment override ($)
          <input
            type="number"
            step="0.01"
            min="0"
            placeholder="auto"
            value={d.minOverride ?? ''}
            onChange={(e) =>
              set({ minOverride: e.target.value ? parseFloat(e.target.value) : undefined })
            }
          />
        </label>
        <label>
          Late fee ($) — charged if paid after the due date
          <input
            type="number"
            step="0.01"
            min="0"
            placeholder="0"
            value={d.lateFee ?? ''}
            onChange={(e) =>
              set({ lateFee: e.target.value ? parseFloat(e.target.value) : undefined })
            }
          />
        </label>
        <label>
          Due day of month
          <input
            required
            type="number"
            min="1"
            max="31"
            value={d.dueDay}
            onChange={(e) => set({ dueDay: parseInt(e.target.value) || 1 })}
          />
        </label>
      </div>

      <div className="check-row">
        <label className="check">
          <input
            type="checkbox"
            checked={d.pastDue}
            onChange={(e) =>
              set({
                pastDue: e.target.checked,
                pastDueSince: e.target.checked ? (d.pastDueSince ?? todayISO()) : undefined,
                pastDueAmount: e.target.checked ? d.pastDueAmount : undefined,
              })
            }
          />
          Past due
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={d.reportsToBureau}
            onChange={(e) => set({ reportsToBureau: e.target.checked })}
          />
          Reports to credit bureau
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={d.autopay === true}
            onChange={(e) => set({ autopay: e.target.checked })}
          />
          Autopay
        </label>
      </div>
      {d.autopay && (
        <p className="muted">
          Deducted automatically on the due date, so the planner can't delay it — it plans
          your other payments around it and warns you if the account can't cover it.
        </p>
      )}

      {d.pastDue && (
        <div className="grid">
          <label>
            Past-due amount ($)
            <input
              type="number"
              step="0.01"
              min="0"
              placeholder={`auto: ${fmtMoney(cycleMinimum(preview))}`}
              value={d.pastDueAmount ?? ''}
              onChange={(e) =>
                set({ pastDueAmount: e.target.value ? parseFloat(e.target.value) : undefined })
              }
            />
          </label>
          <label>
            Missed due date
            <input
              type="date"
              value={d.pastDueSince ?? ''}
              onChange={(e) => set({ pastDueSince: e.target.value || undefined })}
            />
          </label>
        </div>
      )}

      <p className="muted">
        Computed minimum this cycle: <strong>{fmtMoney(cycleMinimum(preview))}</strong>
        {' · '}Required now (incl. past due): <strong>{fmtMoney(requiredNow(preview))}</strong>
      </p>

      <div className="form-actions">
        <button className="btn primary" type="submit">
          Save
        </button>
        <button className="btn ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
