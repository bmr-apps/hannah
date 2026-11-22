-- Storage prototype for the school app's hannah schema.
-- Apply only to an isolated test database while the migration is in development.
create schema if not exists hannah;

create table hannah.room_bookings (
  id bigint generated always as identity primary key,
  booking_date date not null,
  room text not null check (btrim(room) <> ''),
  period text not null check (btrim(period) <> ''),
  applicant_name text not null check (btrim(applicant_name) <> ''),
  checked boolean not null default false,
  created_at timestamptz not null default now(),
  constraint one_booking_per_applicant_and_period
    unique (booking_date, applicant_name, period)
);

-- The classroom may be shared. This index serves the existing room/period listing.
create index room_bookings_by_room_period
  on hannah.room_bookings (booking_date, room, period, id);

alter table hannah.room_bookings enable row level security;
revoke all on table hannah.room_bookings from public, anon, authenticated;
