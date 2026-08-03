# Debt Control

A local, private debt-payoff planner. All data stays in your browser (localStorage) — nothing is uploaded anywhere. Use **Income & Balance → Export JSON** to back up.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## How to use it

1. **Income & Balance** — enter your current bank balance (negative is fine if you're in overdraft), your net Paychex paycheck, next payday, and any PayActiv advances you've already pulled (they're deducted from your next check).
2. **Debts** — add every credit card, personal loan, friend loan, rent, and lease. Mark anything past due with the amount and the missed date. Minimum payments are computed automatically (cards: greater of $35 or 1% + monthly interest) unless you override them.
3. **Board** — kanban view sorted by urgency:
   - 🚨 **Bureau report risk** — past due and within ~10 days of the 30-day credit-bureau reporting mark. Pay these first.
   - ⏰ **Past due** — behind, but reporting isn't imminent.
   - 💸 **Needs more money** — the cash-flow plan can't fund these on time.
   - 📅 **Due soon — funded** / ✅ **On track**
4. **Schedule** — every payment sorted by the date money actually moves (which may be after the due date if the cash isn't there yet), with paydays interleaved and the projected bank balance after each payment.

The planner simulates your cash day-by-day over 12 weeks: paychecks land, past-due catch-ups get funded first (closest to bureau reporting wins), then minimums by due date. Whatever is left over is the surplus it suggests putting toward the payoff order (avalanche = highest APR first, or snowball = smallest balance first).

Use **Record payment** on a card after you actually pay — it updates the debt, clears past-due status as you catch up, and adjusts your bank balance.
