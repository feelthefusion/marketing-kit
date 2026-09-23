-- =============================================================================
-- Partner program — the money path, in SQL. Every statement is idempotent: run it after each
-- order.paid / refund event (partner-tracking.ts does), or by hand; re-running changes nothing.
--   psql "$DATABASE_URL" -v min_payout_cents=0 -f partner.sql     (runs all, in order)
-- =============================================================================

-- 1. ACCRUE — a sale commission for every attributed order that doesn't have one yet.
--    Rate = the highest tier the partner had reached (trailing-30-day attributed net, as of
--    that order) or the plan's base rate. Hybrid plans add the flat CPA.
insert into crm_commissions (partner_id, order_id, kind, amount_cents, rate_bps, status, available_at, idem_key)
select a.partner_id, a.order_id, 'sale',
       round(a.net_cents * r.rate_bps / 10000.0)::bigint + p.flat_cents,
       r.rate_bps, 'pending',
       a.attributed_at + make_interval(days => p.hold_days),
       'sale:' || a.order_id
from crm_attributions a
join crm_partners pa          on pa.id = a.partner_id
join crm_commission_plans p   on p.id = pa.plan_id
cross join lateral (
    select coalesce((
        select (t->>'rateBps')::int
        from jsonb_array_elements(p.tiers) t
        where (t->>'minMonthlyNetCents')::bigint <= (
            select coalesce(sum(a2.net_cents), 0) from crm_attributions a2
            where a2.partner_id = a.partner_id
              and a2.attributed_at >  a.attributed_at - interval '30 days'
              and a2.attributed_at <= a.attributed_at)
        order by (t->>'minMonthlyNetCents')::bigint desc
        limit 1), p.rate_bps) as rate_bps
) r
where (not p.new_customers_only or a.new_customer)
on conflict (idem_key) do nothing;

-- 2. CLAW BACK — refunds reverse commission in proportion to the refunded amount.
--    A clawback matures with the sale it offsets, so a pending sale + its refund net to zero.
insert into crm_commissions (partner_id, order_id, kind, amount_cents, rate_bps, status, available_at, idem_key)
select c.partner_id, c.order_id, 'clawback',
       -round(c.amount_cents * least(1.0, abs(rv.amount_cents)::numeric / nullif(a.net_cents, 0)))::bigint,
       c.rate_bps,
       case when c.status = 'pending' then 'pending' else 'approved' end,
       greatest(c.available_at, rv.occurred_at),
       'clawback:' || rv.id
from crm_revenue rv
join crm_commissions c  on c.order_id = rv.parent_id and c.kind = 'sale' and c.status <> 'void'
join crm_attributions a on a.order_id = c.order_id
where rv.kind = 'refund'
on conflict (idem_key) do nothing;

-- 3. APPROVE — out of the hold window.
update crm_commissions set status = 'approved'
where status = 'pending' and available_at <= now();

-- 4. PAYABLE — what each partner is owed now (payouts.ts turns these into crm_payouts rows).
--    min_payout_cents is YOUR choice (default 0 = pay any positive balance).
\if :{?min_payout_cents}
\else
\set min_payout_cents 0
\endif
select pa.id as partner_id, pa.payout_method, pa.payout_handle,
       sum(c.amount_cents) as payable_cents, count(*) filter (where c.kind = 'sale') as orders
from crm_commissions c
join crm_partners pa on pa.id = c.partner_id
where c.status = 'approved' and c.payout_id is null
group by pa.id, pa.payout_method, pa.payout_handle
having sum(c.amount_cents) > greatest(:min_payout_cents, 0)
order by payable_cents desc;

-- 5. SCORECARD — who actually drives profitable customers (growth-optimizer learns from this).
--    net = attributed order value; cost = commissions + audience discount given;
--    repeat_90d = what their referred customers spent AFTER the first order (true LTV signal).
with firsts as (
    select a.partner_id, a.contact_id, min(a.attributed_at) as first_at
    from crm_attributions a where a.new_customer group by 1, 2
), repeat as (
    select f.partner_id, sum(r.amount_cents) as repeat_90d_cents
    from firsts f join crm_revenue r on r.contact_id = f.contact_id
     and r.occurred_at >  f.first_at and r.occurred_at <= f.first_at + interval '90 days'
     and r.kind <> 'refund'
     and r.id not in (select order_id from crm_attributions where partner_id = f.partner_id and new_customer)
    group by 1
), clicks as (
    select pc.partner_id, count(*) as clicks
    from crm_events e join crm_partner_codes pc on pc.code = lower(e.properties->>'code')
    where e.name = 'partner.clicked' group by 1
), money as (
    select partner_id,
           sum(amount_cents) filter (where kind in ('sale','bonus','adjustment')) as earned_cents,
           -coalesce(sum(amount_cents) filter (where kind = 'clawback'), 0)   as clawed_cents
    from crm_commissions where status <> 'void' group by 1
)
select pa.id as partner_id, coalesce(pa.display_name, pa.id::text) as partner, pa.kind, pa.tier,
       count(a.order_id)                                  as orders,
       count(a.order_id) filter (where a.new_customer)    as new_customers,
       coalesce(sum(a.net_cents), 0)                      as net_cents,
       coalesce(m.earned_cents, 0) - coalesce(m.clawed_cents, 0) as commission_cents,
       round(100.0 * coalesce(m.clawed_cents, 0) / nullif(m.earned_cents, 0), 1) as clawback_pct,
       coalesce(rp.repeat_90d_cents, 0)                   as repeat_90d_cents,
       coalesce(ck.clicks, 0)                             as clicks,
       round(coalesce(sum(a.net_cents), 0)::numeric / nullif(ck.clicks, 0))       as net_per_click_cents,
       round((coalesce(sum(a.net_cents), 0) + coalesce(rp.repeat_90d_cents, 0))::numeric
             / nullif(coalesce(m.earned_cents, 0) - coalesce(m.clawed_cents, 0), 0), 2) as return_per_commission_dollar
from crm_partners pa
left join crm_attributions a on a.partner_id = pa.id
left join money  m  on m.partner_id  = pa.id
left join repeat rp on rp.partner_id = pa.id
left join clicks ck on ck.partner_id = pa.id
group by pa.id, pa.display_name, pa.kind, pa.tier, m.earned_cents, m.clawed_cents, rp.repeat_90d_cents, ck.clicks
order by net_cents desc;
