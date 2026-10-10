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
