-- Agent Mail Service: persistent email storage
-- Run this once in the Supabase SQL editor (or via migration tooling).

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

-- Migration 002 (2026-10-20): attachment metadata + retention pruning.
-- attachments stores only filename/contentType/size (never message content).
alter table agent_emails
  add column if not exists attachments jsonb default '[]'::jsonb;

-- Retention: the service prunes in-memory mail older than RETENTION_DAYS
-- (default 7). For Supabase, run this periodically (cron/pg_cron) to match:
-- delete from agent_emails where created_at < now() - interval '7 days';
