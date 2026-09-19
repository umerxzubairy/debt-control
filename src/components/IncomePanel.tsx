import { useState } from 'react'
import type { AppState } from '../types'
import type { Action } from '../store'
import { uid } from '../store'
import { fmtMoney } from '../format'
import { fmtDate, todayISO } from '../engine/dates'

export default function IncomePanel({
  state,
  dispatch,
}: {
  state: AppState
  dispatch: (a: Action) => void
}) {
  const { income, settings } = state
  const advancesTotal = income.advances.reduce((s, a) => s + a.amount, 0)
  const [advAmount, setAdvAmount] = useState('')
  const [advNote, setAdvNote] = useState('')
  const [otAmount, setOtAmount] = useState('')
  const [otDate, setOtDate] = useState(todayISO())
  const [otKind, setOtKind] = useState<'in' | 'out'>('in')
  const [otNote, setOtNote] = useState('')

  return (
    <div className="income">
      <section className="panel">
        <h3>Bank balance</h3>
        <p className="muted">
          Your real balance right now — negative is fine if you're in overdraft. The plan only
          schedules payments when this (plus paydays) covers them, unless you allow overdraft
          below: then it dips into it on the last safe day to beat a due date or a credit-bureau
          report.
        </p>
        <div className="grid">
          <label>
            Current balance ($)
            <input
              type="number"
              step="0.01"
              value={settings.bankBalance}
              onChange={(e) =>
                dispatch({
                  type: 'setSettings',
                  settings: {
                    ...settings,
                    bankBalance: parseFloat(e.target.value) || 0,
                    asOfDate: todayISO(),
                  },
                })
              }
            />
          </label>
          <label>
            Bureau reporting threshold (days past due)
            <input
              type="number"
              min="1"
              value={settings.bureauReportDays}
              onChange={(e) =>
                dispatch({
                  type: 'setSettings',
                  settings: { ...settings, bureauReportDays: parseInt(e.target.value) || 30 },
                })
              }
            />
          </label>
          <label>
            Max overdraft allowed ($) — 0 = never go negative
            <input
              type="number"
              step="1"
              min="0"
              placeholder="0"
              value={settings.overdraftLimit || ''}
              onChange={(e) =>
                dispatch({
                  type: 'setSettings',
                  settings: { ...settings, overdraftLimit: Math.max(0, parseFloat(e.target.value) || 0) },
                })
              }
            />
          </label>
          <label>
            Overdraft fee ($) — if still negative the next night
            <input
              type="number"
              step="0.01"
              min="0"
              placeholder="0"
              value={settings.overdraftFee || ''}
              onChange={(e) =>
                dispatch({
                  type: 'setSettings',
                  settings: { ...settings, overdraftFee: Math.max(0, parseFloat(e.target.value) || 0) },
                })
              }
            />
          </label>
        </div>
      </section>

      <section className="panel">
        <h3>Salary (Paychex)</h3>
        <div className="grid">
          <label>
            Net pay per paycheck ($)
            <input
              type="number"
              step="0.01"
              min="0"
              value={income.payAmount || ''}
              onChange={(e) =>
                dispatch({
                  type: 'setIncome',
                  income: { ...income, payAmount: parseFloat(e.target.value) || 0 },
                })
              }
            />
          </label>
          <label>
            Next payday
            <input
              type="date"
              value={income.nextPayDate}
              onChange={(e) =>
                dispatch({ type: 'setIncome', income: { ...income, nextPayDate: e.target.value } })
              }
            />
          </label>
          <label>
            Living expenses per paycheck ($) — groceries, gas, etc.
            <input
              type="number"
              step="0.01"
              min="0"
              value={income.livingExpenses || ''}
              placeholder="0"
              onChange={(e) =>
                dispatch({
                  type: 'setIncome',
                  income: { ...income, livingExpenses: parseFloat(e.target.value) || 0 },
                })
              }
            />
          </label>
          <label>
            Pay frequency
            <select
              value={income.frequencyDays}
              onChange={(e) =>
                dispatch({
                  type: 'setIncome',
                  income: { ...income, frequencyDays: parseInt(e.target.value) },
                })
              }
            >
              <option value={7}>Weekly</option>
              <option value={14}>Biweekly (every 2 weeks)</option>
              <option value={15}>Semi-monthly (~15 days)</option>
              <option value={30}>Monthly</option>
            </select>
          </label>
        </div>
      </section>

      <section className="panel">
        <h3>PayActiv advances</h3>
        <p className="muted">
          Money you already pulled early — it's deducted from your <strong>next</strong> paycheck
          ({income.nextPayDate ? fmtDate(income.nextPayDate) : 'not set'}). Total right now:{' '}
          <strong>{fmtMoney(advancesTotal)}</strong>
          {income.payAmount > 0 && (
            <>
              {' '}
              → next check lands at{' '}
              <strong>{fmtMoney(Math.max(0, income.payAmount - advancesTotal))}</strong>
            </>
          )}
          . Clear them after that payday.
        </p>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault()
            const n = parseFloat(advAmount)
            if (!isNaN(n) && n > 0) {
              dispatch({
                type: 'addAdvance',
                advance: { id: uid(), amount: n, date: todayISO(), note: advNote || undefined },
              })
              setAdvAmount('')
              setAdvNote('')
            }
          }}
        >
          <input
            type="number"
            step="0.01"
            min="0.01"
            placeholder="Amount"
            value={advAmount}
            onChange={(e) => setAdvAmount(e.target.value)}
          />
          <input
            placeholder="Note (optional)"
            value={advNote}
            onChange={(e) => setAdvNote(e.target.value)}
          />
          <button className="btn" type="submit">
            Add advance
          </button>
        </form>
        <ul className="advance-list">
          {income.advances.map((a) => (
            <li key={a.id}>
              <span>
                {fmtMoney(a.amount)} — {fmtDate(a.date)}
                {a.note && <span className="muted"> · {a.note}</span>}
              </span>
              <button
                className="btn small ghost"
                onClick={() => dispatch({ type: 'removeAdvance', id: a.id })}
              >
                Remove
              </button>
            </li>
          ))}
          {income.advances.length === 0 && <li className="muted">None recorded.</li>}
        </ul>
      </section>

      <section className="panel">
        <h3>One-time money</h3>
        <p className="muted">
          One-off cash that isn't salary — a bonus, tax refund, money a friend pays back
          (money in), or a car repair, ticket, one-off bill (money out). The plan applies it
          on its date.
        </p>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault()
            const n = parseFloat(otAmount)
            if (!isNaN(n) && n > 0 && otDate) {
              dispatch({
                type: 'addOneTime',
                event: { id: uid(), amount: n, date: otDate, kind: otKind, note: otNote || undefined },
              })
              setOtAmount('')
              setOtNote('')
            }
          }}
        >
          <select value={otKind} onChange={(e) => setOtKind(e.target.value as 'in' | 'out')}>
            <option value="in">Money in</option>
            <option value="out">Money out</option>
          </select>
          <input
            type="number"
            step="0.01"
            min="0.01"
            placeholder="Amount"
            value={otAmount}
            onChange={(e) => setOtAmount(e.target.value)}
          />
          <input type="date" value={otDate} onChange={(e) => setOtDate(e.target.value)} />
          <input
            placeholder="Note (optional)"
            value={otNote}
            onChange={(e) => setOtNote(e.target.value)}
          />
          <button className="btn" type="submit">
            Add
          </button>
        </form>
        <ul className="advance-list">
          {[...income.oneTimes]
            .sort((a, b) => a.date.localeCompare(b.date))
            .map((e) => (
              <li key={e.id}>
                <span>
                  <span className={e.kind === 'in' ? 'ok' : 'warn'}>
                    {e.kind === 'in' ? '+' : '−'}
                    {fmtMoney(e.amount)}
                  </span>{' '}
                  — {fmtDate(e.date)}
                  {e.note && <span className="muted"> · {e.note}</span>}
                  {e.date < todayISO() && <span className="pill"> past</span>}
                </span>
                <button
                  className="btn small ghost"
                  onClick={() => dispatch({ type: 'removeOneTime', id: e.id })}
                >
                  Remove
                </button>
              </li>
            ))}
          {income.oneTimes.length === 0 && <li className="muted">None recorded.</li>}
        </ul>
      </section>

      <section className="panel">
        <h3>Backup</h3>
        <div className="form-actions">
          <button
            className="btn"
            onClick={() => {
              const blob = new Blob([JSON.stringify(state, null, 2)], {
                type: 'application/json',
              })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `debt-control-backup-${todayISO()}.json`
              a.click()
              URL.revokeObjectURL(url)
            }}
          >
            Export JSON
          </button>
          <label className="btn ghost file-btn">
            Import JSON
            <input
              type="file"
              accept="application/json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (!file) return
                file.text().then((text) => {
                  try {
                    const parsed = JSON.parse(text) as AppState
                    if (parsed.debts && parsed.income && parsed.settings) {
                      dispatch({ type: 'importState', state: parsed })
                    } else {
                      alert('Not a valid Debt Control backup file.')
                    }
                  } catch {
                    alert('Could not read that file as JSON.')
                  }
                })
                e.target.value = ''
              }}
            />
          </label>
        </div>
        <p className="muted">All data lives only in this browser. Export before clearing it.</p>
      </section>
    </div>
  )
}
