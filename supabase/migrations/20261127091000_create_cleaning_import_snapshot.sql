-- Private landing table for the original cleaning data, pending the application cutover.
create table hannah.cleaning_import_snapshot (
  source_sha256 text primary key check (source_sha256 ~ '^[a-f0-9]{64}$'),
  imported_at timestamptz not null default now(),
  payload jsonb not null check (jsonb_typeof(payload) = 'object')
);
alter table hannah.cleaning_import_snapshot enable row level security;
revoke all on hannah.cleaning_import_snapshot from public, anon, authenticated;
