-- Staging only. An administrator enrolls fictional test accounts by their Supabase user IDs.
create table hannah.booking_test_members (
  user_id uuid primary key
);
alter table hannah.booking_test_members enable row level security;
revoke all on hannah.booking_test_members from public, anon, authenticated;
grant select on hannah.booking_test_members to authenticated;
create policy read_own_test_membership on hannah.booking_test_members
  for select to authenticated using (user_id = (select bmr.uid()));

create table hannah.booking_test_requests (
  id bigint generated always as identity primary key,
  user_id uuid not null references hannah.booking_test_members(user_id),
  room text not null,
  period text not null,
  unique (user_id, period),
  check ((room, period) in (
    ('강당','저녁2교시'), ('도서관','저녁1교시'), ('7-1','저녁1교시'), ('강당','9교시')
  ))
);
alter table hannah.booking_test_requests enable row level security;
revoke all on hannah.booking_test_requests from public, anon, authenticated;
grant select, insert on hannah.booking_test_requests to authenticated;
create policy test_students_read_own_requests on hannah.booking_test_requests
  for select to authenticated using (user_id = (select bmr.uid()));
create policy test_students_insert_own_requests on hannah.booking_test_requests
  for insert to authenticated with check (
    user_id = (select bmr.uid()) and exists (
      select 1 from hannah.booking_test_members where user_id = (select bmr.uid())
    )
  );

create function hannah.submit_booking_test_request(test_room text, test_period text)
returns bigint language sql security invoker set search_path = '' as $$
  insert into hannah.booking_test_requests (user_id, room, period)
  values ((select bmr.uid()), test_room, test_period)
  returning id;
$$;
revoke all on function hannah.submit_booking_test_request(text,text) from public, anon;
grant execute on function hannah.submit_booking_test_request(text,text) to authenticated;

