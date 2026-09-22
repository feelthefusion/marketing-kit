-- Read-only role for the agent's crm-db MCP (restricted mode on top of this = two locks).
-- Run once as the Railway Postgres owner:  railway connect Postgres  → paste.
-- Then put the growth_ro URL in <repo>/.agents/marketing-kit.env as CRM_DATABASE_URL.
create role growth_ro login password :'growth_ro_password';   -- psql: \set growth_ro_password '...'
grant connect on database railway to growth_ro;
grant usage on schema public to growth_ro;
grant select on all tables in schema public to growth_ro;
alter default privileges in schema public grant select on tables to growth_ro;
alter role growth_ro set statement_timeout = '15s';
alter role growth_ro set idle_in_transaction_session_timeout = '30s';

-- Optional write role for MKT_DB_ACCESS=unrestricted: CRM tables only, never app/billing tables.
-- create role growth_rw login password :'growth_rw_password';
-- grant connect on database railway to growth_rw;
-- grant usage on schema public to growth_rw;
-- grant select on all tables in schema public to growth_rw;
-- grant insert, update, delete on crm_contacts, crm_identities, crm_events, crm_campaigns,
--       crm_enrollments, crm_messages, crm_suppressions to growth_rw;
