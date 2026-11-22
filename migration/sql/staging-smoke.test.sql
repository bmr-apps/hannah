-- Run only in a designated staging database with the room-bookings schema applied.
-- Verifies the database contract without leaving test bookings.
begin;

do $smoke$
declare
  booking_count integer;
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'hannah' and c.relname = 'room_bookings'
      and c.relrowsecurity
  ) then
    raise exception 'Reservation table is missing or RLS is disabled';
  end if;

  if exists (
    select 1 from unnest(array['anon', 'authenticated']) as test_role(role_name)
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as permission(name)
    where has_table_privilege(test_role.role_name, 'hannah.room_bookings', permission.name)
  ) then
    raise exception 'Browser roles must have no direct reservation table access in this prototype';
  end if;

  insert into hannah.room_bookings (booking_date, room, period, applicant_name)
  select date '2099-02-02', '강당', '저녁2교시', '스테이징검증-' || n
  from generate_series(1, 80) as n;

  insert into hannah.room_bookings (booking_date, room, period, applicant_name)
  values (date '2099-02-02', '도서관', '저녁2교시', '스테이징검증-1')
  on conflict on constraint one_booking_per_applicant_and_period do nothing;

  if found then
    raise exception 'Duplicate in another room was accepted';
  end if;

  select count(*) into booking_count
  from hannah.room_bookings
  where booking_date = date '2099-02-02' and room = '강당'
    and period = '저녁2교시' and applicant_name like '스테이징검증-%';

  if booking_count <> 80 then
    raise exception 'Expected 80 auditorium bookings, got %', booking_count;
  end if;
end
$smoke$;

rollback;