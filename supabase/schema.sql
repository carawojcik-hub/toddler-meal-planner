-- Run this in Supabase → SQL Editor → New query → Run
--
-- Then: Authentication → URL configuration
--   Site URL: https://YOUR.vercel.app (and http://localhost:5173 for local dev)
--   Redirect URLs: add the same URLs
-- For a shared household account, disable email confirmation:
--   Authentication → Providers → Email → turn off "Confirm email"

create table if not exists public.planner_state (
  user_id uuid primary key references auth.users (id) on delete cascade,
  saved_weeks jsonb not null default '{}'::jsonb,
  user_pool jsonb not null default '{}'::jsonb,
  breakfast_staple_ids jsonb not null default '[]'::jsonb,
  meal_fit_overrides jsonb not null default '{}'::jsonb,
  priority_boost jsonb not null default '{}'::jsonb,
  active_week_start_key text,
  updated_at timestamptz not null default now()
);

alter table public.planner_state enable row level security;

create policy "planner_state_select_own"
  on public.planner_state for select
  using (auth.uid() = user_id);

create policy "planner_state_insert_own"
  on public.planner_state for insert
  with check (auth.uid() = user_id);

create policy "planner_state_update_own"
  on public.planner_state for update
  using (auth.uid() = user_id);
