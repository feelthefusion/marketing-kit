#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=2", "psycopg[binary]>=3.2"]
# ///
"""Synthetic CRM history for the growth-optimizer test (deterministic, seed 7).

  uv run optimizer-synth.py big     1,200 customers × 2 years; churn driven partly by loyalty
                                    engagement (a signal recency alone can't see)
  uv run optimizer-synth.py tiny    40 customers × 1 year → too little data: baselines must be used
Two creators: 'good' brings engaged, repeat buyers; 'bad' brings one-and-done buyers who refund.
"""
import os, sys, uuid
from datetime import datetime, timedelta, timezone
import numpy as np, psycopg

mode = sys.argv[1] if len(sys.argv) > 1 else "big"
rng = np.random.default_rng(7)
N, DAYS = (1200, 730) if mode == "big" else (40, 365)
now = datetime.now(timezone.utc)
contacts, revenue, ledger, attrib, comm = [], [], [], [], []
PLAN = "synth"; GOOD, BAD = str(uuid.UUID(int=0xA11)), str(uuid.UUID(int=0xB22))
GOOD_C, BAD_C = str(uuid.UUID(int=0xC11)), str(uuid.UUID(int=0xC22))

for i in range(N):
    cid = str(uuid.UUID(int=0x100000 + i))
    contacts.append((cid, f"s{i}@synth.test"))
    src = "good" if i % 10 == 0 else "bad" if i % 10 == 1 else None
    engaged = rng.random() < (0.85 if src == "good" else 0.1 if src == "bad" else 0.4)
    start = rng.uniform(0, DAYS - 20)
    if engaged:
        ledger.append((cid, int(rng.integers(100, 400)), "earn_action", f"review:{i}", now - timedelta(days=DAYS - start - 1)))
    p_month, hazard = (0.6, 0.03) if engaged else (0.3, 0.2)
    t, n = start, 0
    while t < DAYS:
        if n == 0 or rng.random() < p_month:
            oid = f"so{i}_{n}"; cents = int(rng.uniform(3000, 15000))
            at = now - timedelta(days=DAYS - t)
            revenue.append((oid, cid, "new" if n == 0 else "renewal", cents, at, None))
            if n == 0 and src:
                pid = GOOD if src == "good" else BAD
                attrib.append((oid, pid, "code", cid, True, cents, at))
                comm.append((pid, oid, "sale", int(cents * 0.2), "approved", at, f"sale:{oid}"))
                if src == "bad" and rng.random() < 0.5:
                    revenue.append((f"rf_{oid}", cid, "refund", -cents, at + timedelta(days=3), oid))
            n += 1
            if src == "bad":
                break
        if rng.random() < hazard:
            break
        t += 30

with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as c, c.cursor() as cur:
    cur.executemany("insert into crm_contacts (id, email) values (%s, %s)", contacts + [(GOOD_C, "good@creator.test"), (BAD_C, "bad@creator.test")])
    cur.execute("insert into crm_commission_plans (id, name, rate_bps) values (%s, 'synth', 2000) on conflict do nothing", (PLAN,))
    cur.executemany("insert into crm_partners (id, contact_id, kind, plan_id, status, created_at) values (%s, %s, 'creator', %s, 'active', %s)",
                    [(GOOD, GOOD_C, PLAN, now - timedelta(days=DAYS)), (BAD, BAD_C, PLAN, now - timedelta(days=DAYS))])
    cur.executemany("insert into crm_revenue (id, contact_id, kind, amount_cents, currency, occurred_at, parent_id) values (%s,%s,%s,%s,'USD',%s,%s)", revenue)
    cur.executemany("insert into crm_loyalty_ledger (contact_id, points, kind, ref, created_at) values (%s,%s,%s,%s,%s)", ledger)
    cur.executemany("insert into crm_attributions (order_id, partner_id, method, contact_id, new_customer, net_cents, attributed_at) values (%s,%s,%s,%s,%s,%s,%s)", attrib)
    cur.executemany("insert into crm_commissions (partner_id, order_id, kind, amount_cents, status, available_at, idem_key) values (%s,%s,%s,%s,%s,%s,%s)", comm)
print(f"{mode}: {len(contacts)} customers, {sum(1 for r in revenue if r[2] != 'refund')} orders, {len(attrib)} attributed")
