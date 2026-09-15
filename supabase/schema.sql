-- Roligt Foods Operations Control — Supabase schema
--
-- Run this once in the Supabase SQL Editor (Project → SQL Editor → New query).
-- Safe to re-run: everything is guarded, and the migration at the foot only copies
-- the old single-row state across if the new tables are still empty.
--
-- Two things to do in the dashboard as well, which SQL cannot do for you:
--   1. Authentication → Providers → Email: turn "Allow new users to sign up" OFF.
--      Create operators from the dashboard instead.
--   2. Make yourself an admin, once, so you can grant it to anyone else:
--        update public.app_user set role = 'Admin' where email = 'you@example.com';

-- ═══ Who may do what ══════════════════════════════════════════════════════════
--
-- Every authenticated user used to be able to do everything: delete a batch, wipe
-- records from a date, rewrite a numbering series. `Role` existed in the TypeScript
-- and was never once checked. This is the table the policies below actually read.
create table if not exists public.app_user (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  -- Operator: the day job — receive, produce, pack, dispatch.
  -- Admin: the above, plus masters, settings, numbering and record cleanup.
  role text not null default 'Operator' check (role in ('Operator', 'Admin')),
  created_at timestamptz not null default now()
);

alter table public.app_user enable row level security;

create or replace function public.is_admin()
  returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_user where id = auth.uid() and role = 'Admin');
$$;

drop policy if exists "read own app_user" on public.app_user;
create policy "read own app_user" on public.app_user for select
  to authenticated using (id = auth.uid() or public.is_admin());

drop policy if exists "admins read app_user" on public.app_user;
drop policy if exists "admins write app_user" on public.app_user;
create policy "admins write app_user" on public.app_user for all
  to authenticated using (public.is_admin()) with check (public.is_admin());

-- Everyone who signs in gets an Operator row automatically, so nobody is locked out
-- and nobody is silently an admin.
create or replace function public.handle_new_user()
  returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.app_user (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

insert into public.app_user (id, email)
select id, email from auth.users on conflict (id) do nothing;

-- ═══ Change counter ═══════════════════════════════════════════════════════════
--
-- One number, bumped by a trigger on every write anywhere. A client polls this — one
-- tiny row — to notice that somebody else has posted something, instead of pulling
-- the whole plant down the wire every few seconds to find out nothing has changed.
create table if not exists public.app_revision (
  id text primary key,
  rev bigint not null default 0
);
insert into public.app_revision (id, rev) values ('main', 0) on conflict (id) do nothing;

alter table public.app_revision enable row level security;
drop policy if exists "read revision" on public.app_revision;
create policy "read revision" on public.app_revision for select to authenticated using (true);

create or replace function public.bump_revision()
  returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.app_revision set rev = rev + 1 where id = 'main';
  return null;
end;
$$;

-- ═══ Documents ════════════════════════════════════════════════════════════════
--
-- One row per document, replacing the single JSONB blob every client read at boot and
-- wrote back whole. That one decision caused most of the serious problems: two
-- operators overwrote each other silently, the row grew without bound, the ledger had
-- no index, and — because an operator has to write that row to do their job — the
-- database could not tell a receipt from an edit to the item master, so role
-- separation could only ever be enforced in the UI. All four are fixed by this split.
--
-- The document keeps a `data` payload rather than a column per field. That is what
-- lets the application's in-memory shape stay exactly as it was, so no screen and no
-- posting rule had to change for this migration. The ledger — the thing anything
-- actually queries — does get real columns. Typing the rest is the next step.

do $$
declare t text;
begin
  foreach t in array array[
    'vendors', 'customers', 'purchase_products', 'storage_locations', 'items',
    'products', 'melanges', 'test_parameters',
    'grns', 'batches', 'packing_runs', 'orders', 'qcs', 'dispatches',
    'stock_issues', 'lab_reports', 'sticker_templates', 'sticker_prints'
  ]
  loop
    execute format(
      'create table if not exists public.%I (
         id text primary key,
         data jsonb not null,
         updated_at timestamptz not null default now())', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop trigger if exists bump_rev on public.%I', t);
    execute format(
      'create trigger bump_rev after insert or update or delete on public.%I
       for each statement execute function public.bump_revision()', t);
  end loop;
end $$;

-- ── Masters: everyone reads, only an administrator writes ─────────────────────
--
-- This is the part that could not be enforced before. An operator receiving a load
-- needs to write a receipt; they have never needed to rewrite the item master, and
-- now the database is what says so rather than a hidden nav link.
do $$
declare t text;
begin
  foreach t in array array[
    'vendors', 'customers', 'purchase_products', 'storage_locations',
    'items', 'products', 'melanges', 'test_parameters'
  ]
  loop
    execute format('drop policy if exists "read %s" on public.%I', t, t);
    execute format(
      'create policy "read %s" on public.%I for select to authenticated using (true)', t, t);
    execute format('drop policy if exists "admin write %s" on public.%I', t, t);
    execute format(
      'create policy "admin write %s" on public.%I for all to authenticated
       using (public.is_admin()) with check (public.is_admin())', t, t);
  end loop;
end $$;

-- ── The day's work: any signed-in operator may post ───────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'grns', 'batches', 'packing_runs', 'orders', 'qcs', 'dispatches',
    'stock_issues', 'lab_reports', 'sticker_templates', 'sticker_prints'
  ]
  loop
    execute format('drop policy if exists "read %s" on public.%I', t, t);
    execute format(
      'create policy "read %s" on public.%I for select to authenticated using (true)', t, t);
    execute format('drop policy if exists "write %s" on public.%I', t, t);
    execute format(
      'create policy "write %s" on public.%I for all to authenticated
       using (true) with check (true)', t, t);
  end loop;
end $$;

-- ═══ Stock ledger ═════════════════════════════════════════════════════════════
--
-- Real columns, because this is the one table anything queries: every balance,
-- valuation and traceability answer in the app is folded out of it, and it is the only
-- one that grows without limit. Inside the blob it had no index at all.
create table if not exists public.ledger (
  id text primary key,
  type text not null,
  doc text not null,
  item text not null,
  item_type text not null,
  lot text not null,
  location text not null,
  status text not null,
  qty_in numeric not null default 0,
  qty_out numeric not null default 0,
  uom text not null,
  unit_cost numeric not null default 0,
  at timestamptz not null default now(),
  -- Finished goods only: two runs off one batch sit in the same lot under different
  -- dates, so the date travels on the line rather than being looked up from the batch.
  expiry date,
  -- Packing-material receipts only: the supplier it was bought from.
  vendor_id text,
  constraint ledger_one_direction check (qty_in = 0 or qty_out = 0)
);

-- A stock row is item · lot · location · status · expiry; this is the index that
-- serves folding the ledger down to balances.
create index if not exists ledger_stock_idx
  on public.ledger (item, lot, location, status);
-- Reversing a document deletes its lines, which is the other access path.
create index if not exists ledger_doc_idx on public.ledger (doc);
create index if not exists ledger_at_idx on public.ledger (at desc);

alter table public.ledger enable row level security;
drop policy if exists "read ledger" on public.ledger;
create policy "read ledger" on public.ledger for select to authenticated using (true);
drop policy if exists "write ledger" on public.ledger;
create policy "write ledger" on public.ledger for all to authenticated
  using (true) with check (true);

drop trigger if exists bump_rev on public.ledger;
create trigger bump_rev after insert or update or delete on public.ledger
  for each statement execute function public.bump_revision();

-- ═══ Audit trail ══════════════════════════════════════════════════════════════
--
-- Insert-only: there is no update policy, so not even an administrator can edit
-- history through the API. It used to live inside the same blob every client could
-- rewrite, which meant it could prove nothing at all. Deleting is allowed only for an
-- administrator, because clearing test records from a date has to take its entries
-- with it — and that clearance is itself written to the trail afterwards.
create table if not exists public.audits (
  id text primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  doc text,
  details text
);

create index if not exists audits_at_idx on public.audits (at desc);
create index if not exists audits_doc_idx on public.audits (doc);

alter table public.audits enable row level security;
drop policy if exists "read audits" on public.audits;
create policy "read audits" on public.audits for select to authenticated using (true);
drop policy if exists "append audits" on public.audits;
create policy "append audits" on public.audits for insert to authenticated with check (true);
drop policy if exists "admin clear audits" on public.audits;
create policy "admin clear audits" on public.audits for delete
  to authenticated using (public.is_admin());

drop trigger if exists bump_rev on public.audits;
create trigger bump_rev after insert or update or delete on public.audits
  for each statement execute function public.bump_revision();

-- ═══ Counters and configuration ═══════════════════════════════════════════════
--
-- Counters advance every time a document is minted, so an operator must be able to
-- write them. Tolerances, numbering shapes and label copy are the administrator's.
create table if not exists public.app_counters (
  key text primary key,
  value text not null
);
alter table public.app_counters enable row level security;
drop policy if exists "read counters" on public.app_counters;
create policy "read counters" on public.app_counters for select to authenticated using (true);
drop policy if exists "write counters" on public.app_counters;
create policy "write counters" on public.app_counters for all to authenticated
  using (true) with check (true);

create table if not exists public.app_config (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_config enable row level security;
drop policy if exists "read config" on public.app_config;
create policy "read config" on public.app_config for select to authenticated using (true);
drop policy if exists "admin write config" on public.app_config;
create policy "admin write config" on public.app_config for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop trigger if exists bump_rev on public.app_counters;
create trigger bump_rev after insert or update or delete on public.app_counters
  for each statement execute function public.bump_revision();
drop trigger if exists bump_rev on public.app_config;
create trigger bump_rev after insert or update or delete on public.app_config
  for each statement execute function public.bump_revision();

-- ═══ QC report uploads ════════════════════════════════════════════════════════
--
-- Private, not public: these carry customer names and lab results, and a public bucket
-- hands them to anyone who guesses a URL. The app reads them through signed URLs.
insert into storage.buckets (id, name, public)
values ('qc-reports', 'qc-reports', false)
on conflict (id) do update set public = false;

drop policy if exists "authenticated upload qc-reports" on storage.objects;
create policy "authenticated upload qc-reports" on storage.objects for insert
  to authenticated with check (bucket_id = 'qc-reports');

drop policy if exists "public read qc-reports" on storage.objects;
drop policy if exists "authenticated read qc-reports" on storage.objects;
create policy "authenticated read qc-reports" on storage.objects for select
  to authenticated using (bucket_id = 'qc-reports');

-- ═══ Migration from the single-row state ══════════════════════════════════════
--
-- Copies an existing `app_state` blob into the tables above, once. Runs only when the
-- new tables are still empty, so re-running this file is harmless, and it leaves
-- `app_state` untouched — keep it until you are satisfied, then drop it by hand.
do $$
declare
  blob jsonb;
  pair record;
  mapping text[][] := array[
    ['vendors', 'vendors'], ['customers', 'customers'],
    ['purchase_products', 'purchaseProducts'], ['storage_locations', 'storageLocations'],
    ['items', 'items'], ['products', 'products'], ['melanges', 'melanges'],
    ['test_parameters', 'testParameters'], ['grns', 'grns'], ['batches', 'batches'],
    ['packing_runs', 'packingRuns'], ['orders', 'orders'], ['qcs', 'qcs'],
    ['dispatches', 'dispatches'], ['stock_issues', 'stockIssues'],
    ['lab_reports', 'labReports'], ['sticker_prints', 'stickerPrints']
  ];
  i int;
begin
  if to_regclass('public.app_state') is null then return; end if;
  if exists (select 1 from public.ledger) or exists (select 1 from public.grns) then
    raise notice 'Tables already hold data — migration skipped.';
    return;
  end if;

  select data into blob from public.app_state where id = 'main';
  if blob is null then return; end if;

  for i in 1 .. array_length(mapping, 1) loop
    execute format(
      'insert into public.%I (id, data)
       select value->>''id'', value from jsonb_array_elements($1->%L)
       where value ? ''id''
       on conflict (id) do nothing',
      mapping[i][1], mapping[i][2]) using blob;
  end loop;

  -- Sticker layouts are keyed by the stage they print for, not by an id.
  insert into public.sticker_templates (id, data)
  select value->>'stage', value from jsonb_array_elements(blob->'stickerTemplates')
  where value ? 'stage'
  on conflict (id) do nothing;

  -- Ledger ids used to be six random characters, which is a coin-flip that two of
  -- them repeat by the fifty-thousandth line. That was harmless inside the blob —
  -- nothing keyed on them — but `id` is the primary key here, so a plain insert with
  -- "on conflict do nothing" would silently drop the second of any repeated pair and
  -- quietly change the stock. Repeats keep every line and get a suffix instead.
  with numbered as (
    select value, ord,
           row_number() over (partition by value->>'id' order by ord) as dup
    from jsonb_array_elements(blob->'ledger') with ordinality as t(value, ord)
    where value ? 'id'
  )
  insert into public.ledger (
    id, type, doc, item, item_type, lot, location, status,
    qty_in, qty_out, uom, unit_cost, at, expiry, vendor_id)
  select
    case when dup = 1 then value->>'id' else (value->>'id') || '-' || dup end,
    value->>'type', value->>'doc', value->>'item', value->>'itemType',
    value->>'lot', value->>'location', value->>'status',
    coalesce((value->>'qtyIn')::numeric, 0), coalesce((value->>'qtyOut')::numeric, 0),
    value->>'uom', coalesce((value->>'unitCost')::numeric, 0),
    coalesce((value->>'time')::timestamptz, now()),
    nullif(value->>'expiry', '')::date, nullif(value->>'vendorId', '')
  from numbered
  on conflict (id) do nothing;

  -- Entries written while the trail was a list inside the blob have no key of their
  -- own; they are given one derived from position and time, matching what the client's
  -- migration mints, so the two cannot disagree.
  insert into public.audits (id, at, actor, action, doc, details)
  select
    coalesce(
      value->>'id',
      'AUD-LEGACY-' || (ord - 1)::text || '-' ||
      (extract(epoch from (value->>'time')::timestamptz) * 1000)::bigint::text),
    (value->>'time')::timestamptz, value->>'role', value->>'action',
    value->>'doc', value->>'details'
  from jsonb_array_elements(blob->'audits') with ordinality as t(value, ord)
  on conflict (id) do nothing;

  for pair in select key, value from jsonb_each_text(blob->'counters') loop
    insert into public.app_counters (key, value) values (pair.key, pair.value)
    on conflict (key) do nothing;
  end loop;
  for pair in select key, value from jsonb_each_text(coalesce(blob->'counterPeriods', '{}'::jsonb)) loop
    insert into public.app_counters (key, value) values ('period:' || pair.key, pair.value)
    on conflict (key) do nothing;
  end loop;

  insert into public.app_config (id, data) values ('main', blob->'config')
  on conflict (id) do nothing;

  raise notice 'Migrated app_state into per-document tables.';
end $$;
