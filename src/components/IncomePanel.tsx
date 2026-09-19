import { useState } from 'react'
import type { AppState } from '../types'
import type { Action } from '../store'
import { uid } from '../store'
import { fmtMoney } from '../format'
import { addDays, fmtDate, todayISO } from '../engine/dates'
import { buildPaychecks } from '../engine/paychecks'

export default function IncomePanel({
  state,
  dispatch,
}: {
  state: AppState
  dispatch: (a: Action) => void
}) {
  const { income, settings } = state
  const advancesTotal = income.advances.reduce((s, a) => s + a.amount, 0)
  const nextPayDate = buildPaychecks(income, todayISO(), addDays(todayISO(), 62))[0]?.date
  const adv = state.advance
  const setAdv = (patch: Partial<typeof adv>) =>
    dispatch({ type: 'setAdvance', advance: { ...adv, ...patch } })
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
            Pay schedule
            <select
              value={income.scheduleKind}
              onChange={(e) => {
                const scheduleKind = e.target.value as 'interval' | 'monthly'
                dispatch({
                  type: 'setIncome',
                  income: {
                    ...income,
                    scheduleKind,
                    // start from the common 1st/15th pattern rather than an empty list
                    monthlyPaychecks:
                      scheduleKind === 'monthly' && income.monthlyPaychecks.length === 0
                        ? [
                            { payDay: 1, periodStartDay: 8, periodEndDay: 23 },
                            { payDay: 15, periodStartDay: 23, periodEndDay: 8 },
                          ]
                        : income.monthlyPaychecks,
                  },
                })
              }}
            >
              <option value="interval">Every N days</option>
              <option value="monthly">Fixed days each month</option>
            </select>
          </label>
          {income.scheduleKind === 'interval' && (
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
          )}
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
          {income.scheduleKind === 'interval' && (
            <>
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
              <label>
                Days between period end and payday
                <input
                  type="number"
                  min="0"
                  value={income.periodLagDays}
                  onChange={(e) =>
                    dispatch({
                      type: 'setIncome',
                      income: { ...income, periodLagDays: Math.max(0, parseInt(e.target.value) || 0) },
                    })
                  }
                />
              </label>
            </>
          )}
        </div>

        {income.scheduleKind === 'monthly' && (
          <div className="paychecks">
            <p className="muted">
              One row per paycheck each month: the day you're paid, and the days of the month its
              work period runs from and to. Example: paid the <strong>1st</strong> for the{' '}
              <strong>8th → 23rd</strong>, and the <strong>15th</strong> for the{' '}
              <strong>23rd → 8th</strong>. The work period decides how much you can advance.
            </p>
            {income.monthlyPaychecks.map((p, i) => (
              <div className="paycheck-row" key={i}>
                {(
                  [
                    ['Paid on day', 'payDay'],
                    ['Work period from day', 'periodStartDay'],
                    ['…to day', 'periodEndDay'],
                  ] as const
                ).map(([label, key]) => (
                  <label key={key}>
                    {label}
                    <input
                      type="number"
                      min="1"
                      max="31"
                      value={p[key]}
                      onChange={(e) =>
                        dispatch({
                          type: 'setIncome',
                          income: {
                            ...income,
                            monthlyPaychecks: income.monthlyPaychecks.map((x, j) =>
                              j === i
                                ? { ...x, [key]: Math.min(31, Math.max(1, parseInt(e.target.value) || 1)) }
                                : x,
                            ),
                          },
                        })
                      }
                    />
                  </label>
                ))}
                <button
                  className="btn small ghost"
                  onClick={() =>
                    dispatch({
                      type: 'setIncome',
                      income: {
                        ...income,
                        monthlyPaychecks: income.monthlyPaychecks.filter((_, j) => j !== i),
                      },
                    })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <div>
              <button
                className="btn small"
                onClick={() =>
                  dispatch({
                    type: 'setIncome',
                    income: {
                      ...income,
                      monthlyPaychecks: [
                        ...income.monthlyPaychecks,
                        { payDay: 1, periodStartDay: 1, periodEndDay: 15 },
                      ],
                    },
                  })
                }
              >
                + Add paycheck
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <h3>Advances already taken</h3>
        <p className="muted">
          Money you already pulled early with PayActiv — it's deducted from your{' '}
          <strong>next</strong> paycheck ({nextPayDate ? fmtDate(nextPayDate) : 'not set'}). Total
          right now:{' '}
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
        <h3>Pay advance planning (PayActiv)</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={adv.enabled}
            onChange={(e) => setAdv({ enabled: e.target.checked })}
          />
          Let the plan take pay advances to make payments on time
        </label>
        <p className="muted">
          When a payment would otherwise be late — or cost an overdraft fee — the plan requests an
          advance on the last safe day, for just what's missing. It comes out of your next
          paycheck with the fee, and the plan only keeps an advance if that leaves you better off
          overall. Your employer sets the real limits and fees, so check them in the PayActiv app.
        </p>
        <div className="preset-row">
          <button
            className="btn small"
            onClick={() => setAdv({ fee: 3, leadDays: 0 })}
            title="Money arrives instantly for a $3 flat fee"
          >
            Preset: instant, $3 flat fee
          </button>
          <button
            className="btn small"
            onClick={() => setAdv({ fee: 0, leadDays: 3 })}
            title="Bank (ACH) transfers are free but take 1–3 business days"
          >
            Preset: bank transfer (free, ~3 days)
          </button>
        </div>
        <div className="grid">
          <label>
            Fee per advance ($) — fixed
            <input
              type="number"
              step="0.01"
              min="0"
              value={adv.fee}
              onChange={(e) => setAdv({ fee: Math.max(0, parseFloat(e.target.value) || 0) })}
            />
          </label>
          <label>
            Days until the money arrives (0 = instant)
            <input
              type="number"
              min="0"
              max="10"
              value={adv.leadDays}
              onChange={(e) =>
                setAdv({ leadDays: Math.min(10, Math.max(0, parseInt(e.target.value) || 0)) })
              }
            />
          </label>
          <label>
            Max per pay period (% of your paycheck)
            <input
              type="number"
              min="1"
              max="100"
              value={adv.maxPercent}
              onChange={(e) =>
                setAdv({ maxPercent: Math.min(100, Math.max(1, parseFloat(e.target.value) || 50)) })
              }
            />
          </label>
        </div>
        <p className="muted">
          {income.payAmount > 0 ? (
            <>
              That's up to <strong>{fmtMoney((income.payAmount * adv.maxPercent) / 100)}</strong>{' '}
              advanced per pay period. The limit resets when a paycheck repays what you took.
            </>
          ) : (
            <>Set your net pay above to see the dollar limit.</>
          )}
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={adv.limitToEarned}
            onChange={(e) => setAdv({ limitToEarned: e.target.checked })}
          />
          Only allow that share of wages earned so far (the limit grows day by day)
        </label>
        <p className="muted">
          Turn this on if the PayActiv app shows you less early in a pay period. Off, the plan
          assumes the full limit is available any day.
        </p>
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
