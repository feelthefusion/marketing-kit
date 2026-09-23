-- =============================================================================
-- Loyalty — points + tiers + store credit, in SQL. Idempotent: run after every order.paid /
-- refund (loyalty.ts does) or by hand; re-running changes nothing.
--   psql "$DATABASE_URL" -v points_per_dollar=1 -f loyalty.sql
-- Optional expiry: -v expiry_days=365   (unset = points never expire — the default)
-- =============================================================================
\if :{?points_per_dollar}
\else
\set points_per_dollar 1
\endif
\if :{?expiry_days}
\set has_expiry true
\else
\set expiry_days ''
\set has_expiry false
\endif

-- 1. TIER — rolling 12-month net spend → the highest tier reached. A view, so it is never stale.
create or replace view crm_loyalty_status as
with spend as (
    select c.id as contact_id,
           coalesce(sum(r.amount_cents) filter (where r.occurred_at > now() - interval '12 months'), 0) as spend_12m_cents
    from crm_contacts c left join crm_revenue r on r.contact_id = c.id
    group by c.id
), pts as (
    select contact_id, sum(points) as points from crm_loyalty_ledger group by 1
), credit as (
    select contact_id, sum(amount_cents) as credit_cents from crm_store_credit group by 1
)
select s.contact_id, s.spend_12m_cents,
       t.id as tier, t.rank as tier_rank, t.earn_multiplier_bps,
       nt.id as next_tier, greatest(nt.min_spend_12m_cents - s.spend_12m_cents, 0) as to_next_tier_cents,
       coalesce(p.points, 0)::int as points, coalesce(cr.credit_cents, 0)::bigint as store_credit_cents
from spend s
left join lateral (select * from crm_loyalty_tiers t where t.min_spend_12m_cents <= s.spend_12m_cents order by rank desc limit 1) t on true
left join lateral (select * from crm_loyalty_tiers t where t.min_spend_12m_cents >  s.spend_12m_cents order by rank asc  limit 1) nt on true
left join pts p     on p.contact_id  = s.contact_id
left join credit cr on cr.contact_id = s.contact_id;

-- 2. EARN — points for every paid order, at the tier multiplier the customer had.
insert into crm_loyalty_ledger (contact_id, points, kind, ref, expires_at)
select r.contact_id,
       floor(r.amount_cents / 100.0 * :points_per_dollar * coalesce(st.earn_multiplier_bps, 10000) / 10000.0)::int,
       'earn_order', r.id,
       case when :'expiry_days' = '' then null::timestamptz
            else r.occurred_at + make_interval(days => nullif(:'expiry_days', '')::int) end
from crm_revenue r
join crm_loyalty_status st on st.contact_id = r.contact_id
where r.kind in ('new', 'expansion', 'renewal') and r.amount_cents > 0 and r.contact_id is not null
on conflict (contact_id, kind, ref) do nothing;

-- 3. CLAW BACK — refunds remove the points their order earned, proportionally.
insert into crm_loyalty_ledger (contact_id, points, kind, ref)
select rv.contact_id,
       -ceil(l.points * least(1.0, abs(rv.amount_cents)::numeric / nullif(o.amount_cents, 0)))::int,
       'clawback', rv.id
from crm_revenue rv
join crm_revenue o        on o.id = rv.parent_id
join crm_loyalty_ledger l on l.ref = o.id and l.kind = 'earn_order'
where rv.kind = 'refund'
on conflict (contact_id, kind, ref) do nothing;

-- 4. EXPIRE (only if you set expiry_days) — FIFO: spent points consume the oldest first.
\if :has_expiry
insert into crm_loyalty_ledger (contact_id, points, kind, ref)
select contact_id, -expired, 'expire', 'expire:' || current_date
from (
    select contact_id,
           greatest(sum(points) filter (where points > 0 and expires_at <= now())
                    + coalesce(sum(points) filter (where points < 0), 0), 0) as expired
    from crm_loyalty_ledger group by contact_id
) x
where expired > 0
on conflict (contact_id, kind, ref) do nothing;
\endif

-- 5. WHO TO NUDGE — close to the next tier or sitting on redeemable points (lifecycle-engine
--    segments read these; the optimizer decides which offer).
select st.contact_id, st.tier, st.next_tier, st.to_next_tier_cents, st.points,
       (select max(cost_points) from crm_loyalty_rewards w
         where w.active and w.cost_points <= st.points and w.min_tier_rank <= coalesce(st.tier_rank, 0)) as best_redeemable_reward_points
from crm_loyalty_status st
where (st.next_tier is not null and st.to_next_tier_cents <= 5000)
   or st.points >= (select min(cost_points) from crm_loyalty_rewards where active)
order by st.to_next_tier_cents nulls last;
