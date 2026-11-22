-- Kitchen Circuit lock-screen notifications. Paste into Supabase > SQL Editor and Run.
create table if not exists public.push_subs (endpoint text primary key, sub jsonb not null, team text not null, updated_at timestamptz not null default now());
create table if not exists public.push_sent (match text not null, team text not null, sent_at timestamptz not null default now(), primary key (match, team));
alter table public.push_subs enable row level security;
alter table public.push_sent enable row level security;

-- a phone signs up for its team's notifications (no login needed)
create or replace function public.save_push(p_endpoint text, p_sub jsonb, p_team text) returns void
language sql security definer set search_path = public as $$
  insert into public.push_subs (endpoint, sub, team, updated_at)
  select p_endpoint, p_sub, p_team, now()
  where length(p_endpoint) < 1000 and p_endpoint like 'https://%' and length(p_team) < 10
  on conflict (endpoint) do update set sub = excluded.sub, team = excluded.team, updated_at = now();
$$;

-- a phone turns notifications off (or the sender removes a phone that no longer exists)
create or replace function public.drop_push(p_endpoint text) returns void
language sql security definer set search_path = public as $$
  delete from public.push_subs where endpoint = p_endpoint;
$$;

-- scorekeepers only: phones to notify for a called match, skipping teams already told in the last 10 minutes
create or replace function public.push_targets(p_match text, p_teams text[])
returns table (o_team text, o_endpoint text, o_sub jsonb)
language plpgsql security definer set search_path = public as $$
declare t text; fresh text[] := '{}';
begin
  if not public.is_editor() then raise exception 'not allowed'; end if;
  foreach t in array p_teams loop
    if not exists (select 1 from public.push_sent s where s.match = p_match and s.team = t and s.sent_at > now() - interval '10 minutes') then
      insert into public.push_sent as s (match, team, sent_at) values (p_match, t, now())
        on conflict on constraint push_sent_pkey do update set sent_at = now();
      fresh := fresh || t;
    end if;
  end loop;
  return query select p.team, p.endpoint, p.sub from public.push_subs p where p.team = any (fresh);
end $$;

revoke all on function public.save_push(text, jsonb, text) from public;
revoke all on function public.drop_push(text) from public;
revoke all on function public.push_targets(text, text[]) from public;
grant execute on function public.save_push(text, jsonb, text) to anon, authenticated;
grant execute on function public.drop_push(text) to anon, authenticated;
grant execute on function public.push_targets(text, text[]) to authenticated;
