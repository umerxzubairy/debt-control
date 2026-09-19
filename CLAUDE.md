# Debt Control — agent notes

Local-first personal debt payoff planner. React 18 + TypeScript + Vite 5, **zero other runtime deps, no backend** — keep it that way unless the user asks otherwise.

## Commands

```bash
npm run dev      # Vite dev server on :5173 (also via .claude/launch.json → preview tools)
npm run build    # tsc -b && vite build (use this as the type-check gate)
```

## Architecture

- `src/types.ts` — all domain types (`Debt`, `Income`, `Settings`, `PlanResult`, …).
- `src/store.ts` — `useReducer` + localStorage persistence. Single JSON blob under key `debt-control-v1`. New fields must get defaults in `initialState` — `load()` deep-merges `initialState` over stored data (`income`/`settings` one level deep), which is the whole migration story.
- `src/engine/planner.ts` — the core. `buildPlan()` simulates cash **day-by-day over 84 days**: paydays land (minus PayActiv advances on the *next* check only, minus per-check living expenses), one-time in/out events apply on their date, then obligations are funded greedily in priority order (past-due catch-ups sorted by days-until-bureau-report first, then minimums by due date). A payment's `plannedDate` is the first day cash covers it → status `on_time` / `late` / `unfunded`.
- `src/engine/minPayment.ts` — `cycleMinimum()` (cards: max($35, 1% + monthly interest); loans: installment; user `minOverride` always wins) and `requiredNow()` (adds past-due amount).
- `src/engine/dates.ts` — dates are **local-time `YYYY-MM-DD` strings** everywhere; compare with string `<=`. Never use `new Date(isoString)` directly (UTC shift bug) — use `parseISO`/`toISO` helpers.
- `src/components/` — `Board` (kanban by urgency), `Schedule` (rows sorted by when money moves), `Debts` (CRUD + form), `IncomePanel` (salary, advances, living expenses, one-time money, backup).

## Domain gotchas

- `type: 'rent'` is special-cased as **recurring** in the planner (monthly forever) and excluded from payoff order; every other debt's obligations stop when the balance runs out.
- `reportsToBureau: false` (friend loans, rent) → no bureau-risk column/countdown.
- `autopay: true` makes a debt's *regular cycle* payments **fixed-date**: the planner deducts them on `dueDate` unconditionally (status `on_time`, or `overdraft` if the balance goes negative — the overdrawn part counts toward `shortfall`), and flexible payments hold back `autopayReserve()` = autopay amounts due before the next inflow. Past-due catch-ups on an autopay debt stay manual. Nothing auto-mutates state when the date passes — the user still records payments/bank balance themselves (their entered balance already reflects real deductions).
- **Overdraft** (`settings.overdraftLimit` / `overdraftFee`, both default 0 = old behaviour). In `buildPlan()`, a flexible payment cash can't cover may be funded by overdraft **only on its `deadline` day** (due date; or `since + bureauReportDays - 1 - BUREAU_SAFETY_DAYS` for bureau-reporting catch-ups, which keep retrying every day after that), only if `cash - amount - autopayReserve - extraFee >= -limit`, and only if `worthIt`: bureau-critical catch-ups always; otherwise the marginal overdraft fee must be 0 or smaller than the debt's `lateFee`. The bank charges `overdraftFee` **once per episode** at end of day when the balance has been negative 2 nights running; `feeExpected()` peeks at tomorrow's forced money (payday/one-time/autopay) to prefer overdrafts that clear by morning — this is why a payment can land the night before a payday, fee-free. Payment status `overdraft` = paid while balance < 0 (autopay or flexible). Autopay may exceed the limit (forced); only the part past the limit counts toward `shortfall`.
- **Late fees** (`Debt.lateFee`) are a *projection*: a regular payment planned after its due date (or unfunded) reports `lateFee`; totals in `PlanResult.lateFees`. They are not added to balances or cash, and catch-ups get none (that fee is already in the user's past-due amount).
- The kanban columns are *derived* from `PlanResult` per debt, not stored state.
- `recordPayment` reduces debt balance **and** bank balance, and clears past-due as the catch-up amount is covered.

## Verifying changes

Seed realistic data by writing a state JSON to localStorage key `debt-control-v1` via browser JS and reloading (see git history / past sessions for a full seed snippet), check the Board/Schedule tabs, then `localStorage.removeItem('debt-control-v1')` before finishing — never leave fake data in the user's browser. The user keeps real financial data in this app: don't clobber existing localStorage without exporting first.

## Deployment

GitHub Pages via `.github/workflows/deploy.yml` on push to `main`. `vite.config.ts` uses `base: './'` — don't change to an absolute base or Pages project URLs break.
