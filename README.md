# Roligt Foods — Operations Control

Plant operations for a tender-coconut processor, from the load arriving at the gate to
the challan leaving with the vehicle: procurement, extraction and melange production,
QC release, packing, orders, dispatch, stock and traceability.

Everything the plant does is recorded as a document, and every document writes lines
into one append-only stock ledger. Nothing stores a balance — every quantity, cost and
valuation on every screen is folded out of that ledger. That is the single idea the
rest of the codebase follows from.

## Running it

```bash
npm install
cp .env.example .env.local     # fill in your Supabase project's URL and anon key
npm run dev
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server against your real Supabase project |
| `npm run build` | Typecheck and production build |
| `npm run lint` | oxlint |

### Supabase setup

Run `supabase/schema.sql` once in the SQL editor. Then, in the dashboard:

1. **Authentication → Providers → Email: turn off "Allow new users to sign up."**
   A new sign-up becomes an Operator automatically, which is enough to post against
   the plant. Create operators from the dashboard instead.
2. Create your account under **Authentication → Users**, then make it an admin by
   putting its email into `supabase/set-admin.sql` and running that file:
   ```sql
   update public.app_user set role = 'Admin' where email = 'you@example.com';
   ```
3. Moving an existing plant off the old single-row `app_state`? Run
   `supabase/verify-migration.sql` afterwards — every table should match what the old
   row held.

The `supabase/` folder holds exactly these three files: the schema, the admin grant,
and the migration check.

Roles are `Operator` (receive, produce, pack, dispatch) and `Admin` (that, plus
masters, settings, numbering and clearing records).

## How the code is laid out

```
src/lib/        the rules — pure, no React, no Supabase
src/context/    state, persistence and every write the app can make
src/pages/      one screen per route
src/components/ shared UI
```

`src/lib` is deliberately free of React and of the Supabase client, so the arithmetic
that matters — landed cost, usable yield, by-product cost allocation, stock folding,
document numbering — can be read on its own. If you are adding a rule, it goes there.

Worth reading first, in this order: `src/types.ts` (the domain, heavily commented),
`src/lib/stock.ts` (how a balance is derived), `src/lib/posting.ts` (what each document
is allowed to do and the ledger lines it writes).

## Things to know before changing anything

**A stock row is item · lot · location · status · expiry.** All five. Two runs off one
batch, packed on different days into the same freezer, are two different rows and are
not interchangeable stock. Use `rowKey` / `isRow` from `src/lib/stock.ts` whenever you
name a row — dropdowns, React keys, allocation maps. Getting this wrong has caused the
same bug more than once.

**Check totals, not rows.** Two lines of one form can name the same lot. Compared one
at a time each clears; added up they take more than there is. Aggregate first.

**Documents are edited by reversing and re-posting.** Every `update*` deletes its own
ledger lines and writes them again, and validates against stock with its own lines
excluded (`withoutDoc`). Quantities freeze once something downstream draws on them.

**Never sum across units of measure.** Coconuts are pieces, beetroot is kilograms. Use
`sumByUom` / `fmtByUom`.

**Dates come from the local clock.** Use `toDateKey`, never `toISOString().slice(0,10)`
— in IST that is yesterday until half past five in the morning.

## Persistence

Each document is a row in its own table. A save works out what changed against the
last state the database is known to hold and writes only that, so two operators
posting two different receipts are two independent writes rather than a race to
overwrite the plant. Changes are written to the device first, so work done without
signal survives a refresh and uploads on reconnect. Clients poll a trigger-maintained
revision counter to notice each other's postings.

Because the split is real, **role separation is enforced by the database**, not just
by the UI: masters are admin-write, the day's work is operator-write, and the audit
trail is insert-only with no update policy at all.

The ledger has real columns and three indexes; it is the one table anything queries
and the only one that grows without limit. The document tables keep a `data` jsonb
payload rather than a column per field — that is what let the in-memory shape stay
identical through the migration, so no screen or posting rule had to change. Giving
them typed columns is the next step, and a much smaller one from here.

Two people editing the *same* document within a save window still resolve
last-write-wins on that row; the poll then shows the other's version. That is a far
narrower window than the whole database, but it is not zero.

`supabase/schema.sql` migrates an existing `app_state` blob into the tables once,
only when they are still empty, and leaves the old row alone so you can check the
result before dropping it.
