import type { AppState, PlanResult, PlannedStatus } from '../types'
import { fmtMoney } from '../format'
import { fmtDate, fmtDateShort } from '../engine/dates'

type Row =
  | {
      kind: 'payday'
      date: string
      net: number
      advancesDeducted: number
      livingDeducted: number
      periodStart: string
      periodEnd: string
    }
  | {
      kind: 'advance'
      date: string
      amount: number
      fee: number
      requestDate: string
      repayDate: string | null
      forDebts: string[]
    }
  | { kind: 'oneTime'; date: string; amount: number; direction: 'in' | 'out'; note?: string }
  | { kind: 'fee'; date: string; amount: number; balanceAfter: number }
  | {
      kind: 'payment'
      date: string | null
      dueDate: string
      name: string
      amount: number
      status: PlannedStatus
      autopay: boolean
      lateFee: number
      missesBureau: boolean
      bureauGap?: number
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
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
    })),
    ...plan.advances.map((a) => ({
      kind: 'advance' as const,
      date: a.arrivalDate,
      amount: a.amount,
      fee: a.fee,
      requestDate: a.requestDate,
      repayDate: a.repayDate,
      forDebts: a.forDebts,
    })),
    ...plan.oneTimes.map((e) => ({
      kind: 'oneTime' as const,
      date: e.date,
      amount: e.amount,
      direction: e.kind,
      note: e.note,
    })),
    ...plan.overdraftFeeEvents.map((f) => ({
      kind: 'fee' as const,
      date: f.date,
      amount: f.amount,
      balanceAfter: f.balanceAfter,
    })),
    ...plan.payments.map((p) => ({
      kind: 'payment' as const,
      date: p.plannedDate,
      dueDate: p.dueDate,
      name: p.debtName,
      amount: p.amount,
      status: p.status,
      autopay: p.autopay,
      lateFee: p.lateFee,
      missesBureau: p.missesBureau,
      bureauGap: p.bureauGap,
      isPastDueCatchUp: p.isPastDueCatchUp,
      balanceAfter: p.balanceAfter,
    })),
  ]

  // Sort by the date money actually moves; unfunded items sink to the bottom.
  rows.sort((a, b) => {
    const da = a.date ?? '9999-12-31'
    const db = b.date ?? '9999-12-31'
    if (da !== db) return da.localeCompare(db)
    // same day: money in first, then payments, then the bank's end-of-day fee
    const order = { payday: 0, advance: 0, oneTime: 0, payment: 1, fee: 2 }
    return order[a.kind] - order[b.kind]
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
                  <span className="muted">
                    {' '}
                    · work {fmtDateShort(r.periodStart)}–{fmtDateShort(r.periodEnd)}
                  </span>
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
            ) : r.kind === 'advance' ? (
              <tr key={i} className="payday-row">
                <td>{fmtDate(r.date)}</td>
                <td>—</td>
                <td>
                  ⚡ PayActiv advance
                  <span className="muted">
                    {' '}
                    · for {r.forDebts.join(', ')}
                    {r.requestDate !== r.date && ` · request on ${fmtDateShort(r.requestDate)}`}
                    {' · '}
                    {fmtMoney(r.amount + r.fee)} ({r.fee > 0 ? `${fmtMoney(r.fee)} fee` : 'no fee'})
                    comes out of {r.repayDate ? fmtDateShort(r.repayDate) : 'a later'} pay
                  </span>
                </td>
                <td className="num ok">+{fmtMoney(r.amount)}</td>
                <td />
                <td />
              </tr>
            ) : r.kind === 'fee' ? (
              <tr key={i} className="unfunded-row">
                <td>{fmtDate(r.date)}</td>
                <td>—</td>
                <td>
                  🏦 Overdraft fee
                  <span className="muted"> · still negative the next night</span>
                </td>
                <td className="num danger">−{fmtMoney(r.amount)}</td>
                <td />
                <td className="num muted">{fmtMoney(r.balanceAfter)}</td>
              </tr>
            ) : (
              <tr
                key={i}
                className={r.status === 'unfunded' || r.status === 'overdraft' ? 'unfunded-row' : ''}
              >
                <td>{r.date ? fmtDate(r.date) : '— no cash —'}</td>
                <td>{fmtDate(r.dueDate)}</td>
                <td>
                  {r.name}
                  {r.isPastDueCatchUp && <span className="pill danger-pill">catch-up</span>}
                  {r.autopay && <span className="pill autopay-pill">autopay</span>}
                </td>
                <td className="num">{fmtMoney(r.amount)}</td>
                <td>
                  {r.status === 'on_time' && (
                    <span className="ok">{r.autopay ? 'auto-deducted' : 'on time'}</span>
                  )}
                  {r.status === 'late' && <span className="warn">late</span>}
                  {r.status === 'unfunded' && <span className="danger">unfunded</span>}
                  {r.status === 'overdraft' && (
                    <span className="danger">{r.autopay ? 'overdraft' : 'via overdraft'}</span>
                  )}
                  {r.lateFee > 0 && (
                    <span className="warn"> +{fmtMoney(r.lateFee)} late fee</span>
                  )}
                  {r.missesBureau && (
                    <span className="danger">
                      {' '}
                      🚨 after bureau report date
                      {r.bureauGap != null && ` · ~${fmtMoney(r.bureauGap)} short`}
                    </span>
                  )}
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
