create function hannah.read_cleaning_display_for_date(requested_date date)
returns table(
  class_name text, zone_name text, student_names jsonb, zone_order integer,
  makeup_names jsonb, conflict_names jsonb
)
language sql stable security definer set search_path = ''
as $$
  with snapshot as (
    select payload from hannah.cleaning_import_snapshot
    order by imported_at desc, source_sha256 desc limit 1
  ), day_context as (
    select payload,
      (array['월','화','수','목','금','토','일'])[extract(isodow from requested_date)::int] as day_name,
      ((requested_date - (payload #>> '{quarter,startDate}')::date)/7+1)::text as week_key
    from snapshot
  )
  select r.class_name, r.zone_name, r.student_names,
    coalesce(z.zone_order, 999),
    coalesce(m.names, '[]'::jsonb),
    coalesce(c.names, '[]'::jsonb)
  from hannah.read_cleaning_duties_for_date(requested_date) r
  cross join day_context d
  left join lateral (
    select position::int as zone_order
    from jsonb_array_elements(
      case when jsonb_typeof(d.payload #> array['zones',r.class_name])='array'
        then d.payload #> array['zones',r.class_name] else '[]'::jsonb end
    ) with ordinality as item(zone,position)
    where item.zone->>'name' = r.zone_name
    limit 1
  ) z on true
  left join lateral (
    select jsonb_agg(student.name order by student.position) as names
    from jsonb_array_elements_text(r.student_names) with ordinality as student(name,position)
    where d.payload #>> array['weekdayAssignment',r.class_name,student.name,'day'] in ('월','화','수','목')
      and d.payload #>> array['weekdayAssignment',r.class_name,student.name,'day'] <> d.day_name
  ) m on r.zone_name <> '안내' and r.class_name <> '공통'
  left join lateral (
    select jsonb_agg(student.name order by student.position) as names
    from jsonb_array_elements_text(r.student_names) with ordinality as student(name,position)
    where (d.payload #> array['recyclingAssignment',d.week_key,d.day_name]) ? student.name
  ) c on r.zone_name <> '안내' and r.class_name <> '공통'
  order by r.class_name, coalesce(z.zone_order,999), r.zone_name
$$;
revoke all on function hannah.read_cleaning_display_for_date(date) from public, anon, authenticated;
grant execute on function hannah.read_cleaning_display_for_date(date) to anon, authenticated;
