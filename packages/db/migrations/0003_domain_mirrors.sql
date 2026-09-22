-- 0003_domain_mirrors.sql — §5.4 domain entities needed by M0:
-- parties, items, item_aliases (E2-S4), ledger/voucher/bills mirrors (E2-S3),
-- staged_vouchers (E4 write-back staging), rate_history.
-- Rollback plan: drop these tables; mirrors are re-synced from Tally via the
-- connector, aliases carry `source` provenance and can be rebuilt.

create table parties (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  source text not null default 'tally',
  source_id text not null,
  name text not null,
  gstin text,
  pan text,
  state_code char(2),
  roles text[] not null default '{}',       -- customer|supplier
  contacts jsonb not null default '{}',
  whatsapp_opt_in boolean not null default false,
  credit_terms jsonb not null default '{}',
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tenant_id, source, source_id)
);

create table items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  source text not null default 'tally',
  source_id text not null,
  code text,
  name text not null,
  hsn text,
  uom text,
  item_group text,
  reorder_level numeric(18,3),
  default_rate numeric(14,2),
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tenant_id, source, source_id)
);

create table item_aliases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  party_id uuid references parties(id),
  alias_text text not null,
  item_id uuid not null references items(id),
  confidence numeric(4,3) not null default 1.0,
  embedding vector(1536),                   -- [ASSUMPTION] dimension: Q12, revisit after embedding spike
  source text not null,                     -- ocr|human|import|agent
  confirmed_by uuid,                        -- null = unconfirmed (never auto-applied below threshold)
  created_at timestamptz not null default now()
);

create index item_aliases_exact_idx on item_aliases (tenant_id, alias_text);
create index item_aliases_embedding_idx on item_aliases
  using hnsw (embedding vector_cosine_ops);
create unique index item_aliases_dedup_idx on item_aliases (tenant_id, item_id, alias_text, coalesce(party_id, '00000000-0000-4000-8000-000000000000'::uuid));

create table ledger_mirror (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  source text not null default 'tally',
  source_id text not null,                  -- Tally GUID
  alter_id bigint,
  name text,                                -- ledger name
  parent text,
  balance numeric(18,2),
  raw jsonb not null default '{}',
  synced_at timestamptz not null default now(),
  unique (tenant_id, source, source_id)
);

create table voucher_mirror (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  source text not null default 'tally',
  source_id text not null,                  -- Tally GUID
  alter_id bigint,
  voucher_type text not null,
  date date not null,
  party_id uuid references parties(id),
  voucher_number text,
  amount numeric(14,2) not null default 0,
  lines jsonb not null default '[]',
  raw jsonb not null default '{}',
  synced_at timestamptz not null default now(),
  unique (tenant_id, source, source_id)
);

create index voucher_mirror_party_date_idx on voucher_mirror (tenant_id, party_id, date desc);

create table bills_outstanding (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  source text not null default 'tally',
  source_id text not null,
  party_id uuid references parties(id),
  voucher_id uuid references voucher_mirror(id),
  due_date date,
  amount numeric(14,2) not null,
  outstanding numeric(14,2) not null,
  bills_type text not null default 'receivable', -- receivable|payable
  synced_at timestamptz not null default now(),
  unique (tenant_id, source, source_id)
);

create index bills_outstanding_due_idx on bills_outstanding (tenant_id, due_date);

create table staged_vouchers (               -- §8.3 write-back staging
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  source_action_id uuid references proposed_actions(id),
  voucher_type text not null,
  xml_payload text not null,
  validation_result jsonb,
  status text not null default 'staged',    -- staged|validated|imported|verified|failed|reversed
  tally_guid text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table rate_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  party_id uuid references parties(id),
  item_id uuid references items(id),
  rate numeric(14,2) not null,
  date date not null,
  source_doc uuid references documents(id),
  created_at timestamptz not null default now()
);

create index rate_history_lookup_idx on rate_history (tenant_id, party_id, item_id, date desc);

-- RLS on every tenant-scoped table (§4.5)
alter table parties enable row level security;
create policy tenant_isolation on parties
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table items enable row level security;
create policy tenant_isolation on items
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table item_aliases enable row level security;
create policy tenant_isolation on item_aliases
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table ledger_mirror enable row level security;
create policy tenant_isolation on ledger_mirror
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table voucher_mirror enable row level security;
create policy tenant_isolation on voucher_mirror
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table bills_outstanding enable row level security;
create policy tenant_isolation on bills_outstanding
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table staged_vouchers enable row level security;
create policy tenant_isolation on staged_vouchers
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table rate_history enable row level security;
create policy tenant_isolation on rate_history
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
