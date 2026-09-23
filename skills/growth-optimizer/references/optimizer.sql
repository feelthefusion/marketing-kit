-- =============================================================================
-- growth-optimizer — event wiring. Run once per database (idempotent).
-- Every new order NOTIFYs; `optimize.py --listen` (a Railway service) wakes up and retrains when
-- enough new orders have arrived. No cron, no schedule: orders are the clock.
-- =============================================================================
create or replace function crm_notify_revenue() returns trigger language plpgsql as $$
begin
  perform pg_notify('crm_revenue_inserted', new.id);
  return new;
end $$;

drop trigger if exists crm_revenue_notify on crm_revenue;
create trigger crm_revenue_notify after insert on crm_revenue
  for each row execute function crm_notify_revenue();

-- Optional: a dedicated role for the optimizer — reads the CRM, writes only its own outputs.
-- do $$ begin create role crm_optimizer login password '…'; exception when duplicate_object then null; end $$;
-- grant select on all tables in schema public to crm_optimizer;
-- grant insert, update on crm_scores, crm_model_runs, crm_arms, crm_arm_pulls to crm_optimizer;
-- grant update (fit_score) on crm_creator_prospects to crm_optimizer;
-- grant usage on all sequences in schema public to crm_optimizer;

-- Read side: the scores are plain rows, so segments and campaigns just join them.
--   at-risk VIPs:      join crm_scores s on s.subject_id = c.id::text and s.model = 'churn_90d' and s.value > 0.6
--                      join crm_scores v on v.subject_id = c.id::text and v.model = 'clv' and v.value > 200
--   best creators:     select * from crm_scores where subject_kind = 'partner' and model = 'partner_quality' order by value desc
--   who to recruit:    select * from crm_creator_prospects where stage = 'found' order by fit_score desc nulls last limit 50
