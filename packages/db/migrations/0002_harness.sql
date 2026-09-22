-- 0002_harness.sql — PRD §5.2 harness tables, §5.3 eval tables, E0-S4 feature flags.
-- Rollback plan: drop the tables created here (harness/eval data is
-- reconstructible from business_events + S3 payloads; no destructive ALTERs
-- of Phase-1 tables). Applied only forward; verified by migration tests.

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  agent_id text not null,
  agent_version text not null,
  trigger jsonb not null,
  status text not null,                    -- running|succeeded|failed|cancelled
  mode text not null default 'live',       -- live|shadow|replay
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  cost_inr numeric(12,4) not null default 0,
  trace_id text
);

create table agent_steps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  run_id uuid not null references agent_runs(id),
  seq int not null,
  kind text not null,                      -- llm|tool|validator|policy|human
  name text not null,
  model text, prompt_version text,
  input_tokens int, output_tokens int, latency_ms int,
  cost_inr numeric(12,4),
  input_ref jsonb, output_ref jsonb,
  outcome text,                            -- ok|invalid|error|blocked
  created_at timestamptz not null default now(),
  unique (run_id, seq)
);

create table proposed_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  run_id uuid references agent_runs(id),
  action_type text not null,               -- e.g. tally.post_purchase_voucher
  payload jsonb not null,
  payload_schema_version text not null,
  summary text not null,                   -- human-readable diff
  value_inr numeric(14,2),
  confidence numeric(4,3),
  flags jsonb not null default '[]',
  evidence jsonb not null default '[]',    -- source-document regions, rows, rates
  idempotency_key text not null,
  state text not null,                     -- see §6.3
  decided_mode text,                       -- suggest|approve|auto|shadow
  decision_reason jsonb,
  executed_at timestamptz,
  reversed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create table approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  action_id uuid not null references proposed_actions(id),
  approver_user_id uuid,
  channel text not null,                   -- whatsapp|web
  decision text,                           -- approved|rejected|edited|expired
  edits jsonb,                             -- human corrections (labelled data)
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  token_hash text                          -- one-time signed token
);

create table autonomy_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  action_type text not null,
  configured_level smallint not null default 2 check (configured_level between 0 and 4),
  value_threshold_inr numeric(14,2),
  min_confidence numeric(4,3),
  limits jsonb not null default '{}',      -- e.g. per-party per-week caps, quiet hours
  unique (tenant_id, action_type)
);

create table agent_stats (                  -- rolling rollups feeding earned autonomy
  tenant_id uuid not null references tenants(id),
  action_type text not null,
  window_days int not null,
  samples int not null,
  accuracy numeric(5,4),
  override_rate numeric(5,4),
  reversal_rate numeric(5,4),
  sev1_incidents int not null default 0,
  earned_level smallint not null default 1,
  computed_at timestamptz not null default now(),
  primary key (tenant_id, action_type, window_days)
);

create table eval_datasets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  agent_id text not null,
  version text not null,
  created_at timestamptz not null default now()
);

create table eval_cases (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references eval_datasets(id),
  input_ref jsonb not null,
  expected jsonb not null,
  tags text[] not null default '{}',       -- vendor, language, quality, must_catch
  weight numeric(4,2) not null default 1,
  source text not null                     -- partner_anonymized|synthetic|adversarial
);

create table eval_runs (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references eval_datasets(id),
  agent_version text not null,
  model text not null,
  prompt_version text not null,
  metrics jsonb not null,
  cost_inr numeric(12,4),
  created_at timestamptz not null default now()
);

create table eval_results (
  run_id uuid not null references eval_runs(id),
  case_id uuid not null references eval_cases(id),
  output jsonb not null,
  scores jsonb not null,
  passed boolean not null,
  primary key (run_id, case_id)
);

-- E0-S4: feature flags, evaluated per tenant, cached ≤30 s in-process.
create table feature_flags (
  tenant_id uuid not null references tenants(id),
  flag_key text not null,
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, flag_key)
);

create index agent_runs_tenant_time_idx on agent_runs (tenant_id, started_at desc);
create index proposed_actions_state_idx on proposed_actions (tenant_id, state) where state in ('pending_approval','auto_approved','proposed','policy_evaluated');
create index agent_steps_run_idx on agent_steps (run_id, seq);

-- RLS on every tenant-scoped table (§4.5)
alter table agent_runs enable row level security;
create policy tenant_isolation on agent_runs
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table agent_steps enable row level security;
create policy tenant_isolation on agent_steps
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table proposed_actions enable row level security;
create policy tenant_isolation on proposed_actions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table approvals enable row level security;
create policy tenant_isolation on approvals
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table autonomy_policies enable row level security;
create policy tenant_isolation on autonomy_policies
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

alter table agent_stats enable row level security;
create policy tenant_isolation on agent_stats
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- eval tables are tenant-agnostic (golden datasets are global, versioned);
-- eval_runs/eval_results reference datasets only — no tenant_id column.

alter table feature_flags enable row level security;
create policy tenant_isolation on feature_flags
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
