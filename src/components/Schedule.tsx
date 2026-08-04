import type { AppState, PlanResult } from '../types'
import { fmtMoney } from '../format'
import { fmtDate } from '../engine/dates'

type Row =
  | {
      kind: 'payday'
      date: string
      net: number
      advancesDeducted: number
      livingDeducted: number
    }
  | { kind: 'oneTime'; date: string; amount: number; direction: 'in' | 'out'; note?: string }
  | {
      kind: 'payment'
      date: string | null
      dueDate: string
      name: string
      amount: number
      status: 'on_time' | 'late' | 'unfunded'
      isPastDueCatchUp: boolean
      balanceAfter?: number
    }

export default function Schedule({ plan }: { state: AppState; plan: PlanResult }) {
  const rows: Row[] = [
    ...plan.paydays.map((p) => ({
      kind: 'payday' as const,
      date: p.date,
      net: p.net,
      advancesDeducted: p.advancesDeducted,
      livingDeducted: p.livingDeducted,
    })),
    ...plan.oneTimes.map((e) => ({
      kind: 'oneTime' as const,
      date: e.date,
      amount: e.amount,
      direction: e.kind,
      note: e.note,
    })),
    ...plan.payments.map((p) => ({
      kind: 'payment' as const,
      date: p.plannedDate,
      dueDate: p.dueDate,
      name: p.debtName,
      amount: p.amount,
      status: p.status,
      isPastDueCatchUp: p.isPastDueCatchUp,
      balanceAfter: p.balanceAfter,
    })),
  ]

  // Sort by the date money actually moves; unfunded items sink to the bottom.
  rows.sort((a, b) => {
    const da = a.date ?? '9999-12-31'
    const db = b.date ?? '9999-12-31'
    if (da !== db) return da.localeCompare(db)
    return a.kind !== 'payment' ? -1 : 1
  })

  if (plan.payments.length === 0 && plan.paydays.length === 0) {
    return (
      <p className="empty-msg">
        Add your debts and income first — the schedule builds itself from them.
      </p>
    )
  }

  return (
    <div className="schedule">
      <p className="muted">
        Sorted by the date money actually moves. A payment date after its due date means the
        cash isn't there yet — those rows are marked <span className="warn">late</span>.
      </p>
      <table>
        <thead>
          <tr>
            <th>Pay on</th>
            <th>Due</th>
            <th>What</th>
            <th className="num">Amount</th>
            <th>Status</th>
            <th className="num">Bank after</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) =>
            r.kind === 'payday' ? (
              <tr key={i} className="payday-row">
                <td>{fmtDate(r.date)}</td>
                <td>—</td>
                <td>
                  💰 Payday
                  {r.advancesDeducted > 0 && (
                    <span className="muted"> (−{fmtMoney(r.advancesDeducted)} PayActiv)</span>
                  )}
                  {r.livingDeducted > 0 && (
                    <span className="muted"> (−{fmtMoney(r.livingDeducted)} living)</span>
                  )}
                </td>
                <td className="num ok">+{fmtMoney(r.net)}</td>
                <td />
                <td />
              </tr>
            ) : r.kind === 'oneTime' ? (
              <tr key={i} className={r.direction === 'in' ? 'payday-row' : 'onetime-out-row'}>
                <td>{fmtDate(r.date)}</td>
                <td>—</td>
                <td>
                  {r.direction === 'in' ? '🎁 One-time in' : '🧾 One-time out'}
                  {r.note && <span className="muted"> · {r.note}</span>}
                </td>
                <td className={`num ${r.direction === 'in' ? 'ok' : 'warn'}`}>
                  {r.direction === 'in' ? '+' : '−'}
                  {fmtMoney(r.amount)}
                </td>
                <td />
                <td />
              </tr>
            ) : (
              <tr key={i} className={r.status === 'unfunded' ? 'unfunded-row' : ''}>
                <td>{r.date ? fmtDate(r.date) : '— no cash —'}</td>
                <td>{fmtDate(r.dueDate)}</td>
                <td>
                  {r.name}
                  {r.isPastDueCatchUp && <span className="pill danger-pill">catch-up</span>}
                </td>
                <td className="num">{fmtMoney(r.amount)}</td>
                <td>
                  {r.status === 'on_time' && <span className="ok">on time</span>}
                  {r.status === 'late' && <span className="warn">late</span>}
                  {r.status === 'unfunded' && <span className="danger">unfunded</span>}
                </td>
                <td className="num muted">{r.balanceAfter != null ? fmtMoney(r.balanceAfter) : ''}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  )
}
