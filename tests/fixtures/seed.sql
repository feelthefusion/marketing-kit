-- Synthetic journey for the SQL self-test: anon browsing with UTMs → signup + stitch → onboarding → orders.
insert into crm_contacts (id,email,plan,created_at,first_touch)
select md5('c'||g)::uuid, 'u'||g||'@x.co', case when g%3=0 then 'pro' else 'free' end, now() - (g||' days')::interval,
  case when g%2=0 then jsonb_build_object('utm_source','newsletter','at',now()) end
from generate_series(1,150) g;
insert into crm_events (contact_id,name,source,anon_id,session_id,properties,occurred_at)
select null,'page.viewed','web', md5('a'||(g%250))::uuid::text, md5('s'||g)::uuid::text,
  jsonb_build_object('path', case when g%4=0 then '/pricing' else '/' end, 'referrer', case when g%5=0 then 'https://www.google.com/search' end)
  || case when g%2=0 then jsonb_build_object('utm_source','newsletter','utm_campaign','winback-10d-inactive') else '{}' end,
  now() - ((g%40)||' days')::interval
from generate_series(1,400) g;
with c as (select id, row_number() over () rn from crm_contacts limit 100)
insert into crm_identities (contact_id,kind,value) select id,'anon_id', md5('a'||rn)::uuid::text from c;
update crm_events e set contact_id = i.contact_id from crm_identities i where i.kind='anon_id' and i.value=e.anon_id;
insert into crm_events (contact_id,name,source,anon_id,session_id,occurred_at)
select i.contact_id, 'signup.completed','app', i.value, (select session_id from crm_events x where x.anon_id=i.value limit 1),
  (select min(occurred_at) from crm_events x where x.anon_id=i.value) + interval '1 hour' from crm_identities i;
insert into crm_events (contact_id,name,source,occurred_at)
select contact_id,'onboarding.completed','app', occurred_at + interval '1 day' from crm_events where name='signup.completed' and (hashtext(contact_id::text) % 10) < 6;
insert into crm_events (contact_id,name,source,occurred_at)
select contact_id,'order.paid','app', occurred_at + interval '2 days' from crm_events where name='onboarding.completed' and (hashtext(contact_id::text) % 2) = 0;
insert into crm_events (contact_id,name,source,occurred_at)
select id, 'report.viewed','app', now() - ((hashtext(id::text) % 30 + 30) % 30 || ' days')::interval from crm_contacts where plan='pro';
insert into crm_revenue (id,contact_id,kind,amount_cents,currency,occurred_at)
select 'ord_'||row_number() over (), contact_id, 'new', 4900, 'usd', occurred_at from crm_events where name='order.paid';
