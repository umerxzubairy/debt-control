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
- The kanban columns are *derived* from `PlanResult` per debt, not stored state.
- `recordPayment` reduces debt balance **and** bank balance, and clears past-due as the catch-up amount is covered.

## Verifying changes

Seed realistic data by writing a state JSON to localStorage key `debt-control-v1` via browser JS and reloading (see git history / past sessions for a full seed snippet), check the Board/Schedule tabs, then `localStorage.removeItem('debt-control-v1')` before finishing — never leave fake data in the user's browser. The user keeps real financial data in this app: don't clobber existing localStorage without exporting first.

## Deployment

GitHub Pages via `.github/workflows/deploy.yml` on push to `main`. `vite.config.ts` uses `base: './'` — don't change to an absolute base or Pages project URLs break.
