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

-- Accounts: one per agent, created by POST /api/accounts (free signup) or
-- by an admin with the master token. Only the SHA-256 hash of an API key is
-- stored, so this table never contains a working credential.
create table if not exists agent_accounts (
  id text primary key,
  name text not null default 'agent',
  plan text not null default 'free',
  api_key_hash text not null unique,
  api_key_prefix text not null default '',
  created_at timestamptz default now(),
  address_quota int not null default 25
);

create index if not exists agent_accounts_key_idx
  on agent_accounts (api_key_hash);

-- Address ownership: makes inboxes survive restarts and keeps agents apart.
-- account_id is an agent_accounts.id, the reserved value 'master' for
-- addresses created with AGENT_MAIL_TOKEN, or null for catch-all mail that
-- no account has claimed (readable only with the master token).
-- Deliberately no foreign key: the reserved 'master' owner is not an account.
create table if not exists agent_addresses (
  address text primary key,
  account_id text,
  created_at timestamptz default now(),
  last_seen_at timestamptz default now()
);

create index if not exists agent_addresses_account_idx
  on agent_addresses (account_id, last_seen_at desc);

-- Retention: the service prunes in-memory mail older than RETENTION_DAYS
-- (default 7), and the address-TTL sweep (ADDRESS_TTL_HOURS, default 72)
-- deletes old rows by created_at when it runs against Supabase. To prune
-- purely by retention in Supabase, run this periodically (cron/pg_cron):
-- delete from agent_emails where created_at < now() - interval '7 days';
