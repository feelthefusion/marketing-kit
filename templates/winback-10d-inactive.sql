-- Audience: paid contacts inactive ≥10 days, reachable, not already enrolled in the last 30 days.
-- Read-only SELECT. mkt-preflight --db runs it with LIMIT 0 to prove the columns are real.
select c.id            as contact_id,
       c.email,
       c.phone_e164,
       c.first_name,
       c.traits->>'top_feature' as top_feature,
       c.plan
from   crm_contacts c
where  c.plan <> 'free'
  and  c.last_seen_at < now() - interval '10 days'
  and  not exists (select 1 from crm_suppressions s
                   where s.value in (c.email, c.phone_e164))
  and  not exists (select 1 from crm_enrollments e
                   where e.contact_id = c.id
                     and e.campaign_id = 'winback-10d-inactive'
                     and e.enrolled_at > now() - interval '30 days')
