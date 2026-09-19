# 💳 Debt Control

**A private, local-first debt payoff planner for people digging out of debt.**

Track every credit card, loan, and bill in one place, tell it when you get paid, and it builds a day-by-day cash-flow plan: which payment to make, on which date, from which paycheck — with early warnings before anything gets close to credit-bureau reporting.

All data lives in your browser's localStorage. No server, no account, no tracking — your financial situation never leaves your machine.

## Features

- **Every kind of debt** — credit cards, personal loans, loans from friends, rent, car lease, or anything else. Mark any of them past due with the amount and missed date.
- **Automatic minimum payments** — cards use the standard *greater of $35 or 1% of balance + monthly interest* formula; loans use their installment. Override any of them with the real number from your statement.
- **Autopay** — flag any debt as autopay and the plan treats it as fixed: it leaves your account on the due date no matter what, everything else is planned around it, and you get an overdraft warning if the money won't be there.
- **Overdraft-aware planning** — tell it your bank's max overdraft and overdraft fee. It dips into overdraft only on the last safe day to make a due date or beat a credit-bureau report, never past your limit, prefers overdrafts that clear by the next payday (no fee), and weighs the overdraft fee against the late fee it would avoid.
- **Late fees** — add a late fee to any debt and the schedule shows which payments will trigger it, with a projected-fees total.
- **Real paychecks** — biweekly/weekly/semi-monthly/monthly pay, earned-wage advances (PayActiv etc.) deducted from your next check, and a living-expenses set-aside so the plan never spends your grocery money.
- **Works from your real balance** — start from what's actually in your account, even if you're negative in overdraft.
- **One-time money** — log a bonus, tax refund, or a one-off bill and the plan reflows around it.
- **Kanban board by urgency**:
  - 🚨 **Bureau report risk** — past due and near the ~30-day reporting mark (threshold configurable)
  - ⏰ **Past due** — behind, but reporting isn't imminent
  - 💸 **Needs more money** — the plan can't fund these on time; your signal to act
  - 📅 **Due soon — funded** and ✅ **On track**
- **Payment schedule** — every payment sorted by the date money actually moves (which can be after the due date if the cash isn't there yet), with paydays interleaved and the projected bank balance after each row.
- **Payoff strategy** — avalanche (highest APR first) or snowball (smallest balance first), with the projected surplus you can safely throw at the top of the list.
- **Backup & restore** — export/import your entire state as JSON.

## Getting started

Requires [Node.js](https://nodejs.org) 18+.

```bash
git clone https://github.com/<your-username>/debt-control.git
cd debt-control
npm install
npm run dev
```

Open http://localhost:5173, then:

1. **Income & Balance** — enter your bank balance, net paycheck, next payday, living expenses, and any pay advances.
2. **Debts** — add every debt. Flag anything past due.
3. **Board / Schedule** — see what to pay, when, and what needs more money.

## How the planner works

The engine ([`src/engine/planner.ts`](src/engine/planner.ts)) simulates your cash day-by-day over a 12-week horizon:

1. Paychecks land on your paydays (minus advances and living expenses); one-time money in/out is applied on its date.
2. Obligations are funded in priority order: past-due catch-ups closest to bureau reporting first, then minimums by due date.
3. A payment is scheduled on the first day the cash covers it — if that's after the due date it's flagged **late**, and if it never fits it's **unfunded**.
4. Whatever's left at the end of the horizon is the **surplus** suggested for extra principal on the avalanche/snowball target.

## Deployment

Pushes to `main` deploy automatically to GitHub Pages via [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). One-time setup in your repo: **Settings → Pages → Source → GitHub Actions**.

## Tech stack

React 18 · TypeScript · Vite 5 — no other runtime dependencies, no backend.

```bash
npm run dev      # dev server
npm run build    # type-check + production build
npm run preview  # serve the production build locally
```

## Contributing

Issues and PRs welcome. Keep the core principles intact:

- **Local-first** — no network calls, no telemetry, no accounts.
- **Honest planning** — the schedule shows when money actually moves, not when it should.

## Disclaimer

Debt Control is a planning tool, not financial advice. Computed minimums and the ~30-day bureau-reporting window are common industry conventions — your creditors' actual terms are authoritative.

## License

[MIT](LICENSE)
