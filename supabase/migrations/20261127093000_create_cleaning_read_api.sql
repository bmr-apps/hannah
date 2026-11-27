create table hannah.cleaning_read_admins (user_id uuid primary key);
alter table hannah.cleaning_read_admins enable row level security;
revoke all on hannah.cleaning_read_admins from public, anon, authenticated;

create function hannah.read_cleaning_admin_snapshot()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select snap.payload
  from hannah.cleaning_import_snapshot snap
  where exists (
    select 1 from hannah.cleaning_read_admins admins
    where admins.user_id = (select bmr.uid())
  )
  order by snap.imported_at desc, snap.source_sha256 desc
  limit 1
$$;
revoke all on function hannah.read_cleaning_admin_snapshot() from public, anon, authenticated;
grant execute on function hannah.read_cleaning_admin_snapshot() to authenticated;

create function hannah.read_today_cleaning_duties()
returns table(class_name text, zone_name text, student_names jsonb)
language sql stable security definer set search_path = ''
as $$
  with latest as (
    select payload from hannah.cleaning_import_snapshot
    order by imported_at desc, source_sha256 desc limit 1
  ), calendar as (
    select payload, (current_timestamp at time zone 'Asia/Seoul')::date as today,
      (payload #>> '{quarter,startDate}')::date as start_date
    from latest
  ), slot as (
    select payload, ((today-start_date)/7+1)::text as week_key,
      (array['월','화','수','목','금','토','일'])[extract(isodow from today)::int] as day_key
    from calendar
    where today >= start_date
      and today-start_date < (payload #>> '{quarter,weekCount}')::int * 7
      and extract(isodow from today) between 1 and 4
  )
  select classes.class_key, zones.zone_key, zones.entry->'names'
  from slot
  cross join lateral jsonb_each(slot.payload->'classroomAssignment') as classes(class_key, weeks)
  cross join lateral jsonb_each(classes.weeks #> array[slot.week_key,slot.day_key]) as zones(zone_key,entry)
  where classes.class_key in ('6학년','7-1','7-2','8-1','8-2')
    and jsonb_typeof(zones.entry->'names') = 'array'
    and jsonb_array_length(zones.entry->'names') > 0
  union all
  select '공통', '분리수거', slot.payload #> array['recyclingAssignment',slot.week_key,slot.day_key]
  from slot
  where jsonb_typeof(slot.payload #> array['recyclingAssignment',slot.week_key,slot.day_key]) = 'array'
    and jsonb_array_length(slot.payload #> array['recyclingAssignment',slot.week_key,slot.day_key]) > 0
$$;
revoke all on function hannah.read_today_cleaning_duties() from public, anon, authenticated;
grant execute on function hannah.read_today_cleaning_duties() to anon, authenticated;
