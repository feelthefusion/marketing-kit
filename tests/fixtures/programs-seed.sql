-- Deterministic fixture for partner-program + loyalty-engine tests. Hand-checkable numbers.
-- Plan "creator": 10% base, 15% once trailing-30d attributed net ≥ $1,000, 30-day hold, $2 CPA.
insert into crm_commission_plans (id, name, rate_bps, flat_cents, hold_days, cookie_days, customer_discount_bps, tiers) values
 ('creator',  'Creator',  1000, 200, 30, 30, 1000, '[{"minMonthlyNetCents":100000,"rateBps":1500}]'),
 ('referral', 'Customer referral', 0, 1000, 0, 30, 1000, '[]');

insert into crm_contacts (id, email) values
 ('00000000-0000-0000-0000-00000000c001', 'maya@creator.test'),   -- creator
 ('00000000-0000-0000-0000-00000000c002', 'ref@customer.test'),   -- customer referrer
 ('00000000-0000-0000-0000-0000000000b1', 'b1@x.test'),
 ('00000000-0000-0000-0000-0000000000b2', 'b2@x.test'),
 ('00000000-0000-0000-0000-0000000000b3', 'b3@x.test');

insert into crm_partners (id, contact_id, kind, display_name, plan_id, payout_method, payout_handle) values
 ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000c001', 'creator',  'Maya',  'creator',  'venmo', '+14155550101'),
 ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000c002', 'customer', 'Ref',   'referral', 'store_credit', null);
insert into crm_partner_codes (code, partner_id) values ('maya', '00000000-0000-0000-0000-0000000000a1'), ('ref10', '00000000-0000-0000-0000-0000000000a2');

-- Orders (net cents). Maya: $600 (o1, 40d ago), $500 (o2, 35d ago) → at o2 trailing net = $1,100 ≥ $1,000 → 15%.
--                             $200 (o3, 5d ago) → trailing-30d = $200 only → back to 10%, still in hold.
-- Ref: $80 (o4, 3d ago, 0-day hold → approvable now).
insert into crm_revenue (id, contact_id, kind, amount_cents, currency, occurred_at) values
 ('o1', '00000000-0000-0000-0000-0000000000b1', 'new', 60000, 'USD', now() - interval '40 days'),
 ('o2', '00000000-0000-0000-0000-0000000000b2', 'new', 50000, 'USD', now() - interval '35 days'),
 ('o3', '00000000-0000-0000-0000-0000000000b3', 'new', 20000, 'USD', now() - interval '5 days'),
 ('o4', '00000000-0000-0000-0000-0000000000b3', 'renewal', 8000, 'USD', now() - interval '3 days'),
 ('o5', '00000000-0000-0000-0000-0000000000b1', 'renewal', 30000, 'USD', now() - interval '20 days');  -- b1 repeat (not attributed)
insert into crm_revenue (id, contact_id, kind, amount_cents, currency, occurred_at, parent_id) values
 ('r1', '00000000-0000-0000-0000-0000000000b2', 'refund', -25000, 'USD', now() - interval '33 days', 'o2');  -- half of o2 refunded

insert into crm_attributions (order_id, partner_id, code, method, contact_id, new_customer, net_cents, attributed_at) values
 ('o1', '00000000-0000-0000-0000-0000000000a1', 'maya', 'code',      '00000000-0000-0000-0000-0000000000b1', true,  60000, now() - interval '40 days'),
 ('o2', '00000000-0000-0000-0000-0000000000a1', 'maya', 'link',      '00000000-0000-0000-0000-0000000000b2', true,  50000, now() - interval '35 days'),
 ('o3', '00000000-0000-0000-0000-0000000000a1', 'maya', 'code+link', '00000000-0000-0000-0000-0000000000b3', true,  20000, now() - interval '5 days'),
 ('o4', '00000000-0000-0000-0000-0000000000a2', 'ref10', 'code',     '00000000-0000-0000-0000-0000000000b3', false,  8000, now() - interval '3 days');

insert into crm_events (contact_id, name, source, properties, occurred_at)
select null, 'partner.clicked', 'web', '{"code":"MAYA"}', now() - interval '10 days' from generate_series(1, 100);

-- Loyalty: member ≥ $0 (1×), silver ≥ $500 (1.25×), gold ≥ $1,000 (1.5×).
insert into crm_loyalty_tiers (id, rank, min_spend_12m_cents, earn_multiplier_bps) values
 ('member', 0, 0, 10000), ('silver', 1, 50000, 12500), ('gold', 2, 100000, 15000);
insert into crm_loyalty_rewards (id, name, cost_points, credit_cents) values ('ten-off', '$10 credit', 500, 1000);
