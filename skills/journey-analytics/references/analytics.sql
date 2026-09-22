-- =============================================================================
-- Marketing Kit — first-party analytics SQL (Postgres). Replaces GA4/PostHog reports.
-- Tables: crm_events (collector, source='web'; server facts, source='app'), crm_contacts,
-- crm_revenue (table or VIEW over the app's orders/payments), crm_messages, crm_enrollments.
-- Umami variants at the bottom run on the Umami DB (mcp 'umami'), not the app DB.
-- Every report takes a window; change the interval, never the definition.
-- =============================================================================

-- 1. Traffic by source (sessions, visitors) — last 28 days
with s as (
  select session_id, min(anon_id) anon_id,
         coalesce(max(properties->>'utm_source'),
                  nullif(split_part(regexp_replace(max(properties->>'referrer'), '^https?://(www\.)?', ''), '/', 1), ''),
                  'direct') as source
  from crm_events
  where source = 'web' and occurred_at >= now() - interval '28 days'
  group by session_id)
select source, count(*) sessions, count(distinct anon_id) visitors
from s group by source order by sessions desc;

-- 2. Landing pages → signup rate (first page of each session)
with first_page as (
  select distinct on (session_id) session_id, anon_id, properties->>'path' as landing
  from crm_events where source = 'web' and name = 'page.viewed' and occurred_at >= now() - interval '28 days'
  order by session_id, occurred_at),
signed as (select distinct anon_id from crm_events e join crm_identities i on i.kind = 'anon_id' and i.value = e.anon_id)
select landing, count(*) sessions, count(s.anon_id) signed_up_visitors,
       round(100.0 * count(s.anon_id) / count(*), 1) pct
from first_page f left join signed s using (anon_id)
group by landing having count(*) >= 30 order by sessions desc;

-- 3. Funnel (ordered steps, per person, within 7 days of step 1)
with steps as (
  select coalesce(contact_id::text, anon_id) who, name, occurred_at from crm_events
  where name in ('page.viewed', 'signup.completed', 'onboarding.completed', 'order.paid')
    and occurred_at >= now() - interval '60 days'),
s1 as (select who, min(occurred_at) t1 from steps where name = 'page.viewed' group by who),
s2 as (select s1.who, min(occurred_at) t2 from s1 join steps s using (who) where name = 'signup.completed' and occurred_at between t1 and t1 + interval '7 days' group by s1.who),
s3 as (select s2.who, min(occurred_at) t3 from s2 join steps s using (who) where name = 'onboarding.completed' and occurred_at >= t2 group by s2.who),
s4 as (select s3.who from s3 join steps s using (who) where name = 'order.paid' and occurred_at >= t3 group by s3.who)
select (select count(*) from s1) visited, (select count(*) from s2) signed_up,
       (select count(*) from s3) onboarded, (select count(*) from s4) paid;

-- 4. Weekly retention by signup cohort (active = any event from the contact that week)
with c as (select id, date_trunc('week', created_at) cohort from crm_contacts where created_at >= now() - interval '12 weeks'),
a as (select distinct contact_id, date_trunc('week', occurred_at) wk from crm_events where contact_id is not null and occurred_at >= now() - interval '12 weeks')
select cohort, count(distinct c.id) size,
       round(100.0 * count(distinct a.contact_id) filter (where a.wk = cohort + interval '1 week') / count(distinct c.id), 1) w1,
       round(100.0 * count(distinct a.contact_id) filter (where a.wk = cohort + interval '4 weeks') / count(distinct c.id), 1) w4,
       round(100.0 * count(distinct a.contact_id) filter (where a.wk = cohort + interval '8 weeks') / count(distinct c.id), 1) w8
from c left join a on a.contact_id = c.id group by cohort order by cohort;

-- 5. Revenue by first-touch source (90 days after signup) — source QUALITY, not volume
select coalesce(c.first_touch->>'utm_source', c.first_touch->>'referrer', 'direct') source,
       count(distinct c.id) contacts,
       round(sum(r.amount_cents) filter (where r.occurred_at <= c.created_at + interval '90 days') / 100.0, 2) revenue_90d,
       round(sum(r.amount_cents) filter (where r.occurred_at <= c.created_at + interval '90 days') / 100.0 / count(distinct c.id), 2) per_contact
from crm_contacts c left join crm_revenue r on r.contact_id = c.id
where c.created_at between now() - interval '180 days' and now() - interval '90 days'
group by 1 order by revenue_90d desc nulls last;

-- 6. Campaign clicks → site sessions → conversions (utm_campaign = campaign id)
select properties->>'utm_campaign' campaign, count(distinct session_id) sessions,
       count(distinct contact_id) known_people
from crm_events where source = 'web' and properties ? 'utm_campaign'
  and occurred_at >= now() - interval '30 days'
group by 1 order by sessions desc;

-- 7. Feature adoption among paid contacts (last 30 days)
select e.name, count(distinct e.contact_id) users,
       round(100.0 * count(distinct e.contact_id) / nullif((select count(*) from crm_contacts where plan <> 'free'), 0), 1) pct_of_paid
from crm_events e join crm_contacts c on c.id = e.contact_id
where c.plan <> 'free' and e.source in ('web','app') and e.name not like 'page.%'
  and e.occurred_at >= now() - interval '30 days'
group by 1 order by users desc limit 25;

-- ─── Umami DB (mcp 'umami') ─────────────────────────────────────────────────
-- U1. Visitors/pageviews by utm_campaign (Umami stores utm_* per event)
select utm_campaign, count(distinct session_id) visitors, count(*) pageviews
from website_event where event_type = 1 and utm_campaign is not null
  and created_at >= now() - interval '30 days' group by 1 order by visitors desc;

-- U2. Identified sessions → CRM contact ids (session.distinct_id = crm_contacts.id via identify()).
-- Export these ids and join in the app DB; the two databases are separate by design.
select s.distinct_id contact_id, min(e.created_at) first_seen, count(*) events
from session s join website_event e using (session_id)
where s.distinct_id is not null and e.created_at >= now() - interval '30 days'
group by 1 order by events desc limit 500;
