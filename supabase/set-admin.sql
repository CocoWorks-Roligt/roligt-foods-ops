-- Run AFTER creating the account in the dashboard
-- (Authentication → Users → Add user → Create new user, with "Auto Confirm User" on).
--
-- The trigger in schema.sql gives every new sign-in an `app_user` row as an Operator.
-- This promotes one. Without it, Suppliers, Customers, Products & Materials, Test
-- Parameters and Settings all bounce to the dashboard — which reads as a broken
-- deploy but is only the role.

update public.app_user
set role = 'Admin'
where email = 'admin@roligtfoods.com';

-- Should come back with exactly one Admin.
select email, role, created_at from public.app_user order by created_at;
