-- ONE statement on purpose. The SQL editor only shows the result of the last
-- statement it runs, so a file with two queries silently hides the first.
--
-- Read it top down:
--   auth users          0 means nobody can sign in to this project at all.
--   app_state blob      0 means there was nothing here to migrate.
--   everything else     must match what the blob still holds.

with blob as (select data from public.app_state where id = 'main')
select 1 as ord, 'auth users'        as what, (select count(*) from auth.users)::int      as now_has, null::int as blob_had
union all select 2,  'app_user rows',        (select count(*) from public.app_user)::int,        null
union all select 3,  'app_state blob rows',  (select count(*) from public.app_state)::int,       null
union all select 10, 'ledger',        (select count(*) from public.ledger)::int,        (select jsonb_array_length(data->'ledger')      from blob)
union all select 11, 'grns',          (select count(*) from public.grns)::int,          (select jsonb_array_length(data->'grns')        from blob)
union all select 12, 'batches',       (select count(*) from public.batches)::int,       (select jsonb_array_length(data->'batches')     from blob)
union all select 13, 'packing_runs',  (select count(*) from public.packing_runs)::int,  (select jsonb_array_length(data->'packingRuns') from blob)
union all select 14, 'dispatches',    (select count(*) from public.dispatches)::int,    (select jsonb_array_length(data->'dispatches')  from blob)
union all select 15, 'orders',        (select count(*) from public.orders)::int,        (select jsonb_array_length(data->'orders')      from blob)
union all select 16, 'qcs',           (select count(*) from public.qcs)::int,           (select jsonb_array_length(data->'qcs')         from blob)
union all select 17, 'stock_issues',  (select count(*) from public.stock_issues)::int,  (select jsonb_array_length(data->'stockIssues') from blob)
union all select 18, 'items',         (select count(*) from public.items)::int,         (select jsonb_array_length(data->'items')       from blob)
union all select 19, 'products',      (select count(*) from public.products)::int,      (select jsonb_array_length(data->'products')    from blob)
union all select 20, 'vendors',       (select count(*) from public.vendors)::int,       (select jsonb_array_length(data->'vendors')     from blob)
union all select 21, 'customers',     (select count(*) from public.customers)::int,     (select jsonb_array_length(data->'customers')   from blob)
union all select 22, 'audits',        (select count(*) from public.audits)::int,        (select jsonb_array_length(data->'audits')      from blob)
order by ord;
