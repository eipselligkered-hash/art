-- Art (the dog) checklist: Supabase schema. Same project as the Chores app - all tables are prefixed art_ so nothing clashes.
-- Run once in the Supabase SQL Editor (Project > SQL Editor > New query > paste all > Run). Safe to run again.
-- Every row belongs to one user (owner_id = auth.uid()); row-level security lets only the owner read/write.
-- The app fills in Art's starting list (data/seed.json) the first time you sign in.
create extension if not exists pgcrypto;

create table if not exists public.art_items (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (length(name) between 1 and 120),
  category    text,                                   -- Daily | Treatment | Grooming | Vet | ... (free text)
  frequency   text not null check (frequency in ('Daily','A few times a week','Weekly','Fortnightly','Every 4 weeks','Monthly','Every 2 months','Every 3 months','Every 6 months','Yearly','One-off')),
  last_done   date,                                   -- typed Last done (ticks also count: effective = latest of both)
  due_date    date,                                   -- known/booked next date; used until something is ticked on/after it
  notes       text,
  active      boolean not null default true,          -- false = retired (hidden, history kept)
  sort_key    int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (owner_id, name)
);

create table if not exists public.art_ticks (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  item_id     uuid not null references public.art_items(id) on delete cascade,
  done_on     date not null default current_date,
  who         text check (who in ('Derek','Peter')),  -- optional: who ticked it
  note        text,
  source      text not null default 'app',            -- app | assistant
  cleared_due date,                                   -- the item's due/booked date this tick used up (put back if the tick is removed)
  created_at  timestamptz not null default now(),
  unique (item_id, done_on)
);
create index if not exists art_ticks_item_idx on public.art_ticks (item_id, done_on desc);

create table if not exists public.art_health (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  entry_date  date not null default current_date,
  text        text not null default '',
  weight_kg   numeric(4,1) check (weight_kg > 0 and weight_kg < 100),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists art_health_owner_idx on public.art_health (owner_id, entry_date desc);

create table if not exists public.art_supplies (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (length(name) between 1 and 120),
  low         boolean not null default false,         -- 'running low'
  notes       text,
  sort_key    int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (owner_id, name)
);

-- Row-level security: owner only (same policies as the Chores tables)
alter table public.art_items    enable row level security;
alter table public.art_ticks    enable row level security;
alter table public.art_health   enable row level security;
alter table public.art_supplies enable row level security;

do $$
declare t text;
begin
  foreach t in array array['art_items','art_ticks','art_health','art_supplies'] loop
    execute format('drop policy if exists "owner select" on public.%I', t);
    execute format('drop policy if exists "owner insert" on public.%I', t);
    execute format('drop policy if exists "owner update" on public.%I', t);
    execute format('drop policy if exists "owner delete" on public.%I', t);
    execute format('create policy "owner select" on public.%I for select to authenticated using (owner_id = (select auth.uid()))', t);
    execute format('create policy "owner insert" on public.%I for insert to authenticated with check (owner_id = (select auth.uid()))', t);
    execute format('create policy "owner update" on public.%I for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()))', t);
    execute format('create policy "owner delete" on public.%I for delete to authenticated using (owner_id = (select auth.uid()))', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- a tick may only point at one of your own items
create or replace function public.art_tick_item_owner() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.art_items where id = new.item_id and owner_id = new.owner_id) then
    raise exception 'item % does not belong to this user', new.item_id;
  end if;
  return new;
end $$;
drop trigger if exists art_ticks_owner_check on public.art_ticks;
create trigger art_ticks_owner_check before insert or update on public.art_ticks
  for each row execute function public.art_tick_item_owner();

create or replace function public.art_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists art_items_touch on public.art_items;
create trigger art_items_touch before update on public.art_items for each row execute function public.art_touch_updated_at();
drop trigger if exists art_health_touch on public.art_health;
create trigger art_health_touch before update on public.art_health for each row execute function public.art_touch_updated_at();
drop trigger if exists art_supplies_touch on public.art_supplies;
create trigger art_supplies_touch before update on public.art_supplies for each row execute function public.art_touch_updated_at();

-- live sync between phones (Derek + Peter)
do $$ begin alter publication supabase_realtime add table public.art_items;    exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.art_ticks;    exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.art_health;   exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.art_supplies; exception when others then null; end $$;

-- make the new tables visible to the API straight away
notify pgrst, 'reload schema';
