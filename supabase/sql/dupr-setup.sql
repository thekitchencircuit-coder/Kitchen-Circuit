-- Kitchen Circuit DUPR uploads. Paste into Supabase > SQL Editor and Run (safe to run again).
-- One row per match sent to DUPR: the DUPR match code (needed to update or delete it), what was sent, and any error.
create table if not exists public.dupr_matches (
  identifier  text primary key,          -- our own id for the match, e.g. kc-2026-12-19-Ar0g1
  env         text not null default 'uat', -- uat (DUPR test) or prod (live)
  match_code  text,                      -- DUPR's matchCode from create
  hashed_code text,
  payload     jsonb,                     -- exactly what was sent
  status      text not null,             -- uploaded | error
  error       text,
  response    jsonb,                     -- DUPR's raw reply, for troubleshooting
  updated_at  timestamptz not null default now()
);
alter table public.dupr_matches enable row level security;

-- scorekeepers only: read and write upload records (the dupr Edge Function acts as the signed-in scorekeeper)
drop policy if exists dupr_matches_editors on public.dupr_matches;
create policy dupr_matches_editors on public.dupr_matches
  for all to authenticated using (public.is_editor()) with check (public.is_editor());
