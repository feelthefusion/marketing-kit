-- Cohort library. Every query returns contact_id + the columns a campaign template needs.
-- Copy into campaigns/<id>.sql; declare the returned columns in the campaign's audience.columns;
-- `mkt-preflight --db` proves they match.

-- 1. Churn risk: paid, activity dropped ≥60% vs their own prior 4 weeks
with w as (
  select contact_id,
         count(*) filter (where occurred_at >= now() - interval '14 days')                        as recent,
         count(*) filter (where occurred_at <  now() - interval '14 days'
                            and occurred_at >= now() - interval '42 days') / 2.0                  as baseline
  from crm_events where source in ('web','app') and occurred_at >= now() - interval '42 days'
  group by contact_id)
select c.id as contact_id, c.email, c.first_name, c.plan, w.recent, w.baseline
from w join crm_contacts c on c.id = w.contact_id
where c.plan <> 'free' and w.baseline >= 5 and w.recent <= w.baseline * 0.4;

-- 2. Upsell: hit ≥90% of a plan limit in the last 7 days (event emitted by the app's metering)
select distinct on (c.id) c.id as contact_id, c.email, c.phone_e164, c.first_name, c.plan,
       e.properties->>'limit_name' as limit_name, (e.properties->>'pct')::int as pct_used
from crm_events e join crm_contacts c on c.id = e.contact_id
where e.name = 'usage.limit_90pct' and e.occurred_at >= now() - interval '7 days'
order by c.id, e.occurred_at desc;

-- 3. Activation gap: signed up 3–10 days ago, never reached the activation event
select c.id as contact_id, c.email, c.first_name, c.created_at
from crm_contacts c
where c.created_at between now() - interval '10 days' and now() - interval '3 days'
  and not exists (select 1 from crm_events e where e.contact_id = c.id and e.name = :'activation_event');

-- 4. Acquisition source quality: 90-day revenue per first-touch source (feeds channel budget)
select c.first_touch->>'utm_source' as source, c.first_touch->>'utm_campaign' as campaign,
       count(distinct c.id) as contacts,
       count(distinct r.contact_id) filter (where r.kind = 'new') as paying,
       coalesce(sum(r.amount_cents), 0) / 100.0 as revenue_90d
from crm_contacts c left join crm_revenue r
  on r.contact_id = c.id and r.occurred_at < c.created_at + interval '90 days'
where c.created_at >= now() - interval '180 days'
group by 1, 2 order by revenue_90d desc;

-- 5. Campaign lift with holdout (the only honest "did it work")
select e.variant, e.holdout, count(*) as n,
       count(*) filter (where exists (
         select 1 from crm_events x where x.contact_id = e.contact_id and x.name = :'success_event'
           and x.occurred_at between e.enrolled_at and e.enrolled_at + (:'window_days' || ' days')::interval)) as converted
from crm_enrollments e where e.campaign_id = :'campaign_id'
group by 1, 2 order by 2, 1;

-- 6. Message volume per contact, last 7 days (information only — nothing filters on it)
select contact_id, count(*) as msgs_7d from crm_messages
where created_at >= now() - interval '7 days' and status not in ('skipped','failed')
group by contact_id having count(*) >= 3;
