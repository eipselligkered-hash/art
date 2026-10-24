-- v2: new "How often" choices (A few times a week, Every 4 weeks). Run once in the Supabase SQL Editor; safe to run again.
alter table public.art_items drop constraint if exists art_items_frequency_check;
alter table public.art_items add constraint art_items_frequency_check check (frequency in
  ('Daily','A few times a week','Weekly','Fortnightly','Every 4 weeks','Monthly','Every 2 months','Every 3 months','Every 6 months','Yearly','One-off'));
