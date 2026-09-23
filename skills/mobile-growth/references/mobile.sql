-- =============================================================================
-- Marketing Kit — mobile reports (mobile-growth). App DB (Railway Postgres), first-party only.
-- Mobile web AND the native app, one data model: crm_events.properties carries device / os /
-- inapp / standalone / vw (journey-analytics collector); the app posts with source 'mobile_app';
-- crm_devices + crm_app_installs hold installs, push tokens and how each install arrived.
-- Run: psql "$DATABASE_URL" -f mobile.sql (or paste one numbered block). Read-only.
-- =============================================================================

-- 1. Device mix → conversion (last 28 days): sessions, signups, paid orders per device class
with s as (
  select distinct on (session_id) session_id, anon_id, contact_id, coalesce(properties->>'device', 'unknown') as device
  from crm_events where name = 'page.viewed' and occurred_at > now() - interval '28 days' and session_id is not null
  order by session_id, occurred_at
), who as (select session_id, device, coalesce(contact_id::text, anon_id) as person from s)
select w.device,
       count(distinct w.session_id) as sessions,
       count(distinct w.person) as people,
       count(distinct e.contact_id) filter (where e.name = 'signup.completed') as signups,
       count(distinct e.contact_id) filter (where e.name = 'order.paid') as buyers,
       round(100.0 * count(distinct e.contact_id) filter (where e.name = 'order.paid') / nullif(count(distinct w.person), 0), 2) as buyer_pct
from who w
left join crm_events e on e.contact_id::text = w.person and e.name in ('signup.completed', 'order.paid')
group by w.device order by sessions desc;

-- 2. In-app browsers (Instagram / TikTok / Facebook webviews) vs real browsers on mobile
-- Creator traffic lands here; a low buyer rate says "add an Open-in-browser nudge / skip wallet-only checkout".
select coalesce(properties->>'inapp', 'browser') as opened_in,
       count(distinct session_id) as sessions,
       count(distinct anon_id) filter (where name = 'checkout.started') as checkouts,
       count(distinct anon_id) filter (where name = 'order.paid') as buyers
from crm_events
where properties->>'device' = 'mobile' and occurred_at > now() - interval '28 days'
group by 1 order by sessions desc;

-- 3. Core Web Vitals, p75 per device (Google's thresholds: LCP ≤2500ms · INP ≤200ms · CLS ≤100 = 0.1×1000)
select properties->>'device' as device, properties->>'metric' as metric,
       percentile_cont(0.75) within group (order by (properties->>'value')::numeric) as p75,
       count(*) as samples,
       round(100.0 * count(*) filter (where properties->>'rating' = 'good') / count(*), 1) as good_pct
from crm_events
where name = 'web.vital' and occurred_at > now() - interval '28 days'
group by 1, 2 order by 1, 2;

-- 4. Slowest mobile pages by LCP p75 (fix these first — mobile-first indexing ranks this experience)
select properties->>'path' as path,
       percentile_cont(0.75) within group (order by (properties->>'value')::numeric) as lcp_p75_ms, count(*) as samples
from crm_events
where name = 'web.vital' and properties->>'metric' = 'LCP' and properties->>'device' = 'mobile'
  and occurred_at > now() - interval '28 days'
group by 1 having count(*) >= 5 order by lcp_p75_ms desc limit 20;

-- 5. Mobile checkout drop-off: checkout.started → order.paid within 1 day, per device
select coalesce(c.properties->>'device', 'unknown') as device,
       count(distinct coalesce(c.contact_id::text, c.anon_id)) as started,
       count(distinct coalesce(c.contact_id::text, c.anon_id)) filter (where exists (
         select 1 from crm_events p where p.name = 'order.paid' and p.contact_id = c.contact_id
           and p.occurred_at between c.occurred_at and c.occurred_at + interval '1 day')) as paid
from crm_events c
where c.name = 'checkout.started' and c.occurred_at > now() - interval '28 days'
group by 1 order by started desc;

-- 6. Installed-PWA users vs browser users: 30-day return rate
with firsts as (
  select coalesce(contact_id::text, anon_id) as person, bool_or((properties->>'standalone')::boolean) as pwa, min(occurred_at) as first_at
  from crm_events where name = 'page.viewed' and occurred_at > now() - interval '90 days' group by 1
)
select case when pwa then 'installed_pwa' else 'browser' end as mode, count(*) as people,
       round(100.0 * count(*) filter (where exists (
         select 1 from crm_events e where coalesce(e.contact_id::text, e.anon_id) = f.person
           and e.occurred_at between f.first_at + interval '1 day' and f.first_at + interval '30 days')) / nullif(count(*), 0), 1) as returned_30d_pct
from firsts f group by 1;

-- 7. App installs by source + creator code → paid within 30 days of the claim
select i.source, coalesce(i.partner_code, '—') as partner_code, count(distinct i.install_id) as installs,
       count(distinct d.contact_id) as signed_in,
       count(distinct r.contact_id) as buyers_30d
from crm_app_installs i
left join crm_devices d on d.install_id = i.install_id
left join crm_revenue r on r.contact_id = d.contact_id and r.occurred_at between i.claimed_at and i.claimed_at + interval '30 days'
where i.install_id is not null
group by 1, 2 order by installs desc;

-- 8. Push reach per platform: devices seen in 30 days, opted in, revoked (dead tokens)
select platform,
       count(*) filter (where last_seen_at > now() - interval '30 days') as active_30d,
       count(*) filter (where push_status = 'granted') as push_granted,
       count(*) filter (where push_status = 'denied') as push_denied,
       count(*) filter (where push_status = 'revoked') as push_revoked,
       round(100.0 * count(*) filter (where push_status = 'granted') / nullif(count(*), 0), 1) as opt_in_pct
from crm_devices group by 1 order by 1;

-- 9. Channel scoreboard (last 30 days): the same campaign measured across every channel
select channel, count(*) as sent,
       count(*) filter (where status in ('delivered', 'opened', 'clicked')) as delivered_or_better,
       count(*) filter (where first_opened_at is not null) as opened,
       count(*) filter (where first_clicked_at is not null) as clicked,
       count(*) filter (where status in ('failed', 'bounced')) as failed,
       count(distinct m.contact_id) filter (where exists (
         select 1 from crm_events o where o.contact_id = m.contact_id and o.name = 'order.paid'
           and o.occurred_at between m.sent_at and m.sent_at + interval '3 days')) as buyers_3d
from crm_messages m
where m.sent_at > now() - interval '30 days'
group by 1 order by sent desc;

-- 10. Web → app handoff: creator clicks on the mobile web that became an app install
select e.properties->>'code' as partner_code,
       count(distinct e.anon_id) as mobile_web_clickers,
       count(distinct i.click_id) as installed_app,
       round(100.0 * count(distinct i.click_id) / nullif(count(distinct e.anon_id), 0), 1) as handoff_pct
from crm_events e
left join crm_app_installs i on i.click_id = e.anon_id
where e.name = 'partner.clicked' and e.source = 'web' and e.properties->>'device' = 'mobile'
  and e.occurred_at > now() - interval '90 days'
group by 1 order by mobile_web_clickers desc;
