-- Agent Mail Service: persistent email storage
-- Run this once in the Supabase SQL editor (or via migration tooling).
-- Fully idempotent: safe to re-run.

create table if not exists agent_emails (
  id text primary key,
  address text not null,
  from_addr text,
  subject text,
  date timestamptz,
  text_body text,
  links jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);

create index if not exists agent_emails_address_created_idx
  on agent_emails (address, created_at desc);

-- Attachment metadata (filename, content type, size — never content).
-- The server falls back gracefully if this column is missing.
alter table agent_emails
  add column if not exists attachments jsonb default '[]'::jsonb;

-- Retention: the service prunes in-memory mail older than RETENTION_DAYS
-- (default 7), and the address-TTL sweep (ADDRESS_TTL_HOURS, default 72)
-- deletes old rows by created_at when it runs against Supabase. To prune
-- purely by retention in Supabase, run this periodically (cron/pg_cron):
-- delete from agent_emails where created_at < now() - interval '7 days';
