-- 0001_core.sql — PRD §5.1 core infrastructure tables.
-- Rollback plan (forward-only migrations; documented per Global DoD §0.4):
--   This migration is only ever applied to a fresh database in Phase 1.
--   Rollback = drop database / re-provision. Before first production use,
--   a down-script will be authored alongside the first migration that
--   ALTERs these tables.

create extension if not exists pgcrypto;
create extension if not exists vector;

create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  gstin text,
  state_code char(2),
  plan text not null default 'free',
  autonomy_kill_switch boolean not null default false,
  settings jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table memberships (
  tenant_id uuid not null references tenants(id),
  user_id uuid not null,
  role text not null check (role in
    ('owner','admin','purchase','sales','accounts','production','operator','viewer')),
  phone_e164 text,
  phone_verified_at timestamptz,
  language text not null default 'en',
  primary key (tenant_id, user_id)
);

create table connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  connector text not null,                 -- 'tally','whatsapp','email','indiamart',...
  status text not null default 'pending',  -- pending|active|degraded|paused|revoked
  config jsonb not null default '{}',
  credential_id uuid,
  sync_cursor jsonb not null default '{}',
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create table credentials (                  -- envelope-encrypted secrets
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null,
  ciphertext bytea not null,               -- AES-256-GCM
  nonce bytea not null,
  dek_ref text not null,                   -- KMS-wrapped data key reference
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  source text not null,                    -- whatsapp|email|upload|api
  source_ref text,
  mime text not null,
  storage_path text not null,
  sha256 text not null,
  doc_type text,                           -- invoice|po|challan|quote|statement|unknown
  status text not null default 'received', -- received|classified|extracted|proposed|closed|rejected
  received_at timestamptz not null default now(),
  unique (tenant_id, sha256)
);

create table business_events (              -- append-only
  id bigserial primary key,
  tenant_id uuid not null references tenants(id),
  occurred_at timestamptz not null default now(),
  event_type text not null,
  entity_type text not null,
  entity_id uuid,
  actor_type text not null check (actor_type in ('user','agent','connector','system')),
  actor_id text,
  payload jsonb not null,
  causation_id uuid,
  correlation_id uuid
);

create index business_events_tenant_time_idx on business_events (tenant_id, occurred_at desc);
create index business_events_entity_idx on business_events (tenant_id, entity_type, entity_id);
create index connections_tenant_connector_idx on connections (tenant_id, connector);

-- RLS: every tenant-scoped table (§4.5)
alter table memberships enable row level security;
create policy tenant_isolation on memberships
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table connections enable row level security;
create policy tenant_isolation on connections
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table credentials enable row level security;
create policy tenant_isolation on credentials
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table documents enable row level security;
create policy tenant_isolation on documents
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table business_events enable row level security;
create policy tenant_isolation on business_events
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Append-only: the application role cannot modify history (E2-S2).
revoke update, delete on business_events from public;
