#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy>=2", "pandas>=2.2", "scikit-learn>=1.5", "psycopg[binary]>=3.2"]
# ///
"""
growth-optimizer — learns from YOUR orders and writes scores back into the CRM (crm_scores).

  uv run optimize.py                 train + score everything that has enough data
  uv run optimize.py --if-due        only if enough new orders arrived since the last run
                                     (the event-driven trigger: mkt-update's session hook, or --listen)
  uv run optimize.py --listen        Railway service mode: LISTEN for new orders (pg trigger in
                                     optimizer.sql) and retrain the moment the threshold is crossed
  uv run optimize.py --report        print the last runs' validation metrics, write nothing

Models (each gated: it only writes scores if it BEATS the transparent baseline on held-out data):
  churn_90d        P(no order in the next 90 days)             baseline: recency
  clv              expected spend in the next H days (detail.horizon_days)  baseline: run-rate
  partner_quality  shrunk value per commission dollar           empirical-Bayes (no gate: it IS the model)
  prospect_fit     predicted partner_quality of a creator prospect, learned from signed partners
Arms (crm_arms) are reconciled from crm_arm_pulls + revenue; runtime choice is bandit.ts.

Env: OPTIMIZER_DATABASE_URL (a role that may write crm_scores/crm_model_runs/crm_arms*) or DATABASE_URL.
"""
from __future__ import annotations

import argparse, json, math, os, sys, time
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import psycopg
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, mean_poisson_deviance, roc_auc_score

VERSION = "go-1"
MIN_ORDERS_FOR_MODELS = int(os.environ.get("MKT_MIN_ORDERS", 300))  # below this: baselines only
MIN_NEW_ORDERS = int(os.environ.get("MKT_RETRAIN_ORDERS", 50))       # --if-due threshold (or 10%)
CHURN_H = 90

def dsn() -> str:
    u = os.environ.get("OPTIMIZER_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not u: sys.exit("set OPTIMIZER_DATABASE_URL or DATABASE_URL")
    return u

def q(conn, sql: str, params=None) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(sql, params or {})
        cols = [c.name for c in cur.description] if cur.description else []
        return pd.DataFrame(cur.fetchall(), columns=cols)

# ---- features at a cutoff T (everything strictly before T; labels in [T, T+H)) ---------------
FEATURES = """
with o as (select contact_id, kind, amount_cents, occurred_at from crm_revenue where contact_id is not null),
agg as (
  select contact_id,
    extract(epoch from (%(t)s::timestamptz - max(occurred_at) filter (where kind <> 'refund' and occurred_at < %(t)s))) / 86400 as recency_d,
    extract(epoch from (%(t)s::timestamptz - min(occurred_at) filter (where occurred_at < %(t)s))) / 86400                     as tenure_d,
    count(*)         filter (where kind <> 'refund' and occurred_at < %(t)s)                           as frequency,
    coalesce(sum(amount_cents) filter (where occurred_at < %(t)s), 0)                                   as monetary,
    count(*)         filter (where kind = 'refund' and occurred_at < %(t)s)                             as refunds,
    count(*)         filter (where kind <> 'refund' and occurred_at < %(t)s and occurred_at >= %(t)s::timestamptz - interval '90 days') as orders_90d,
    count(*)         filter (where kind <> 'refund' and occurred_at >= %(t)s and occurred_at < %(t)s::timestamptz + make_interval(days => %(h)s)) as future_orders,
    coalesce(sum(amount_cents) filter (where kind <> 'refund' and occurred_at >= %(t)s and occurred_at < %(t)s::timestamptz + make_interval(days => %(h)s)), 0) as future_spend
  from o group by contact_id
),
pa  as (select distinct contact_id from crm_attributions where new_customer and attributed_at < %(t)s),
pts as (select contact_id, sum(points) as points from crm_loyalty_ledger where created_at < %(t)s group by contact_id),
clk as (select contact_id, count(*) as clicks_90d from crm_messages
        where first_clicked_at < %(t)s and first_clicked_at >= %(t)s::timestamptz - interval '90 days' group by contact_id),
ev  as (select contact_id, count(*) as events_30d from crm_events
        where occurred_at < %(t)s and occurred_at >= %(t)s::timestamptz - interval '30 days' and contact_id is not null group by contact_id)
select a.*, (pa.contact_id is not null)::int as partner_acquired, coalesce(pts.points, 0) as points,
       coalesce(clk.clicks_90d, 0) as clicks_90d, coalesce(ev.events_30d, 0) as events_30d
from agg a
left join pa using (contact_id) left join pts using (contact_id) left join clk using (contact_id) left join ev using (contact_id)
where a.frequency > 0
"""
X_COLS = ["recency_d", "tenure_d", "frequency", "monetary", "refunds", "orders_90d", "partner_acquired", "points", "clicks_90d", "events_30d"]

def snapshot(conn, t: datetime, h: int) -> pd.DataFrame:
    df = q(conn, FEATURES, {"t": t, "h": h})
    for c in X_COLS + ["future_orders", "future_spend"]:
        df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0.0)
    return df

def history_days(conn) -> float:
    r = q(conn, "select extract(epoch from (now() - min(occurred_at))) / 86400 as d, count(*) as n from crm_revenue where kind <> 'refund'")
    return float(r.d[0] or 0), int(r.n[0] or 0)

def upsert_scores(conn, kind: str, model: str, ids, values, details, version: str):
    with conn.cursor() as cur:
        cur.executemany(
            """insert into crm_scores (subject_kind, subject_id, model, value, detail, model_version, scored_at)
               values (%s, %s, %s, %s, %s::jsonb, %s, now())
               on conflict (subject_kind, subject_id, model) do update
               set value = excluded.value, detail = excluded.detail, model_version = excluded.model_version, scored_at = now()""",
            [(kind, str(i), model, float(v), json.dumps(d), version) for i, v, d in zip(ids, values, details)])

def log_run(conn, model: str, version: str, trigger: str, n: int, metrics: dict):
    with conn.cursor() as cur:
        cur.execute("insert into crm_model_runs (model, version, trigger, n_rows, metrics) values (%s, %s, %s, %s, %s::jsonb)",
                    (model, version, trigger, n, json.dumps(metrics)))

# ---- churn + CLV: temporal validation, gated against baselines -------------------------------
def customer_models(conn, trigger: str) -> dict:
    now = datetime.now(timezone.utc)
    hist, n_orders = history_days(conn)
    out = {}
    clv_h = int(max(30, min(365, (hist - 30) / 3)))   # leaves ≥1 horizon of history before the train cutoff
    for model, h in (("churn_90d", CHURN_H), ("clv", clv_h)):
        if hist < 2 * h + 14:
            out[model] = {"skipped": f"needs ≥{2*h+14} days of history, have {hist:.0f}"}; continue
        train = snapshot(conn, now - timedelta(days=2 * h), h)   # labels: [now-2h, now-h)
        valid = snapshot(conn, now - timedelta(days=h), h)       # labels: [now-h, now)   — unseen period
        live  = snapshot(conn, now, h)                           # features today → the scores we write
        if len(live) == 0:
            continue
        if model == "churn_90d":
            y_tr, y_va = (train.future_orders == 0).astype(int), (valid.future_orders == 0).astype(int)
            base_va = valid.recency_d.values                     # longer since last order → more churn
            base_live = live.recency_d.values
            metrics = {"n_train": len(train), "n_valid": len(valid), "base_rate": float(y_va.mean())}
            use_model = False
            if n_orders >= MIN_ORDERS_FOR_MODELS and y_tr.nunique() == 2 and y_va.nunique() == 2:
                m = HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, l2_regularization=1.0, random_state=7)
                m.fit(train[X_COLS], y_tr)
                auc_m = roc_auc_score(y_va, m.predict_proba(valid[X_COLS])[:, 1])
                auc_b = roc_auc_score(y_va, base_va)
                metrics.update(auc_model=round(float(auc_m), 4), auc_baseline=round(float(auc_b), 4))
                use_model = auc_m > auc_b + 0.01
            if use_model:
                vals, version = m.predict_proba(live[X_COLS])[:, 1], f"{VERSION}-gbm"
            else:   # transparent baseline, calibrated: churn rate by recency decile on the validation period
                bins = np.unique(np.quantile(valid.recency_d, np.linspace(0, 1, 11)))
                rate = pd.Series(y_va.values).groupby(np.digitize(base_va, bins[1:-1])).mean()
                vals = np.array([rate.get(b, y_va.mean()) for b in np.digitize(base_live, bins[1:-1])])
                version = f"{VERSION}-baseline"
        else:
            y_tr, y_va = train.future_spend / 100.0, valid.future_spend / 100.0
            run_rate = lambda d: (d.monetary / 100.0) / np.maximum(d.tenure_d, 30) * h   # spend pace × horizon
            metrics = {"n_train": len(train), "n_valid": len(valid), "mean_future_spend": float(y_va.mean())}
            # CLV must predict the MEAN (sums of CLV = forecast revenue), so: Poisson loss, and the
            # gate is Poisson deviance (a proper score for means). MAE is reported, not used — it
            # rewards predicting the median customer, who often spends $0.
            pos = lambda v: np.maximum(np.asarray(v, dtype=float), 0.01)
            base_va = run_rate(valid)
            dev_b = mean_poisson_deviance(y_va, pos(base_va))
            metrics.update(dev_baseline=round(float(dev_b), 3), mae_baseline=round(float(mean_absolute_error(y_va, base_va)), 2))
            use_model = False
            if n_orders >= MIN_ORDERS_FOR_MODELS:
                m = HistGradientBoostingRegressor(loss="poisson", max_iter=300, learning_rate=0.05, random_state=7)
                m.fit(train[X_COLS], y_tr)
                pred_va = m.predict(valid[X_COLS])
                dev_m = mean_poisson_deviance(y_va, pos(pred_va))
                metrics.update(dev_model=round(float(dev_m), 3), mae_model=round(float(mean_absolute_error(y_va, pred_va)), 2),
                               calibration_model=round(float(pred_va.sum() / max(y_va.sum(), 1)), 3))
                use_model = dev_m < dev_b * 0.97
            metrics["calibration_baseline"] = round(float(base_va.sum() / max(y_va.sum(), 1)), 3)
            vals = np.maximum(m.predict(live[X_COLS]), 0) if use_model else run_rate(live).values
            version = f"{VERSION}-gbm" if use_model else f"{VERSION}-baseline"
        metrics["used"] = version
        upsert_scores(conn, "contact", model, live.contact_id, vals, [{"horizon_days": h}] * len(live), version)
        log_run(conn, model, version, trigger, len(live), metrics)
        out[model] = metrics
    return out

# ---- partners: empirical-Bayes value per commission dollar ------------------------------------
def partner_quality(conn, trigger: str) -> dict:
    df = q(conn, """
      select pa.id as partner_id, count(a.order_id) as orders, coalesce(sum(a.net_cents), 0) as net,
             coalesce((select sum(amount_cents) from crm_commissions c where c.partner_id = pa.id and c.status <> 'void'), 0) as commission,
             coalesce((select sum(r.amount_cents) from crm_attributions f join crm_revenue r on r.contact_id = f.contact_id
                        and r.occurred_at > f.attributed_at and r.occurred_at <= f.attributed_at + interval '90 days' and r.kind <> 'refund'
                        and r.id not in (select order_id from crm_attributions where partner_id = pa.id)
                       where f.partner_id = pa.id and f.new_customer), 0) as repeat90,
             greatest(extract(epoch from (now() - pa.created_at)) / 86400, 1) as age_d
      from crm_partners pa left join crm_attributions a on a.partner_id = pa.id
      group by pa.id""")
    if df.empty: return {"skipped": "no partners"}
    for c in ("orders", "net", "commission", "repeat90", "age_d"): df[c] = pd.to_numeric(df[c]).astype(float)
    value = (df.net + df.repeat90) - df.commission                      # contribution before COGS
    per_order = np.where(df.orders > 0, value / df.orders.clip(lower=1), 0.0)
    active = df.orders > 0
    prior = float(np.average(per_order[active], weights=df.orders[active])) if active.any() else 0.0
    k = 5.0                                                              # prior strength, in orders
    shrunk = (k * prior + df.orders * per_order) / (k + df.orders)       # few orders → pulled to the mean
    pace = df.orders / df.age_d * 30                                    # orders per 30 days
    score = shrunk * np.maximum(pace, 0.1)                               # expected contribution / 30 days
    details = [{"orders": int(o), "value_per_order": round(float(s), 2), "orders_per_30d": round(float(p), 2),
                "roi": round(float(v / c), 2) if c else None}
               for o, s, p, v, c in zip(df.orders, shrunk / 100, pace, value, df.commission)]
    upsert_scores(conn, "partner", "partner_quality", df.partner_id, score / 100, details, f"{VERSION}-eb")
    log_run(conn, "partner_quality", f"{VERSION}-eb", trigger, len(df), {"prior_value_per_order": round(prior / 100, 2), "k": k})
    return {"partners": len(df), "prior_value_per_order": round(prior / 100, 2)}

# ---- prospects: learn "what a great creator looks like" from signed partners -----------------
def prospect_fit(conn, trigger: str) -> dict:
    pr = q(conn, "select id, platform, coalesce(followers,0) f, coalesce(engagement_bps,0) e, coalesce(avg_views,0) v, niches from crm_creator_prospects where stage <> 'declined'")
    if pr.empty: return {"skipped": "no prospects"}
    lab = q(conn, """select p.platform, coalesce(p.followers,0) f, coalesce(p.engagement_bps,0) e, coalesce(p.avg_views,0) v, s.value y
                     from crm_partners pa join crm_creator_prospects p on p.id = pa.prospect_id
                     join crm_scores s on s.subject_kind = 'partner' and s.subject_id = pa.id::text and s.model = 'partner_quality'""")
    def feats(d):
        x = pd.DataFrame({"lf": np.log10(pd.to_numeric(d.f).astype(float) + 10), "e": pd.to_numeric(d.e).astype(float),
                          "lv": np.log10(pd.to_numeric(d.v).astype(float) + 10)})
        for p in ("youtube", "instagram", "tiktok"): x[p] = (d.platform == p).astype(int)
        return x
    if len(lab) >= 15:
        m = HistGradientBoostingRegressor(max_iter=200, learning_rate=0.05, random_state=7).fit(feats(lab), pd.to_numeric(lab.y).astype(float))
        vals, version = m.predict(feats(pr)), f"{VERSION}-gbm"
    else:   # heuristic until 15 signed partners have outcomes: engaged reach
        x = feats(pr); vals, version = (x.e / 100.0) * x.lf, f"{VERSION}-heuristic"
    upsert_scores(conn, "prospect", "prospect_fit", pr.id, vals, [{}] * len(pr), version)
    with conn.cursor() as cur:
        cur.executemany("update crm_creator_prospects set fit_score = %s where id = %s", [(float(v), i) for v, i in zip(vals, pr.id)])
    log_run(conn, "prospect_fit", version, trigger, len(pr), {"labelled_partners": len(lab)})
    return {"prospects": len(pr), "labelled": len(lab), "used": version}

# ---- arms: reconcile rewards from real revenue (runtime updates happen in bandit.ts) ---------
def reconcile_arms(conn, window_days: int = 30) -> dict:
    with conn.cursor() as cur:
        cur.execute("""
          update crm_arm_pulls p set rewarded = true, rewarded_at = now(),
                 reward_cents = coalesce((select sum(amount_cents) from crm_revenue r where r.contact_id::text = p.subject_id
                   and r.kind <> 'refund' and r.occurred_at >= p.pulled_at and r.occurred_at < p.pulled_at + make_interval(days => %s)), 0)
                 + coalesce((select sum(net_cents) from crm_attributions a where a.partner_id::text = p.subject_id
                   and a.attributed_at >= p.pulled_at and a.attributed_at < p.pulled_at + make_interval(days => %s)), 0)
          where not p.rewarded and exists (
            select 1 from crm_revenue r where r.contact_id::text = p.subject_id and r.kind <> 'refund'
              and r.occurred_at >= p.pulled_at and r.occurred_at < p.pulled_at + make_interval(days => %s)
            union all
            select 1 from crm_attributions a where a.partner_id::text = p.subject_id
              and a.attributed_at >= p.pulled_at and a.attributed_at < p.pulled_at + make_interval(days => %s))""",
            (window_days,) * 4)
        cur.execute("""
          update crm_arms a set pulls = s.pulls, successes = s.succ, reward_cents = s.cents, updated_at = now()
          from (select experiment_id, arm_id, count(*) pulls, count(*) filter (where rewarded) succ, coalesce(sum(reward_cents),0) cents
                from crm_arm_pulls group by 1, 2) s
          where a.experiment_id = s.experiment_id and a.arm_id = s.arm_id""")
        return {"arms_updated": cur.rowcount}

# ---- triggers ----------------------------------------------------------------------------------
def ready(conn) -> bool:   # program tables migrated? (projects without them: stay silent)
    return bool(q(conn, "select to_regclass('crm_model_runs') is not null and to_regclass('crm_scores') is not null as ok").ok[0])

def due(conn) -> bool:
    if not ready(conn): return False
    r = q(conn, """select (select count(*) from crm_revenue where kind <> 'refund') total,
                          (select count(*) from crm_revenue where kind <> 'refund'
                             and occurred_at > coalesce((select max(trained_at) from crm_model_runs), 'epoch')) fresh""")
    total, fresh = int(r.total[0]), int(r.fresh[0])
    return fresh >= min(MIN_NEW_ORDERS, max(1, math.ceil(total * 0.10))) if total else False

def run_all(trigger: str) -> dict:
    with psycopg.connect(dsn(), autocommit=True) as conn:
        res = {"customers": customer_models(conn, trigger), "partners": partner_quality(conn, trigger),
               "prospects": prospect_fit(conn, trigger), "arms": reconcile_arms(conn)}
    return res

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--if-due", action="store_true"); ap.add_argument("--listen", action="store_true"); ap.add_argument("--report", action="store_true")
    a = ap.parse_args()
    if a.report:
        with psycopg.connect(dsn()) as conn:
            print(q(conn, "select distinct on (model) model, version, trained_at, n_rows, metrics from crm_model_runs order by model, trained_at desc").to_string(index=False))
        return
    if a.listen:   # event-driven service: wakes on every new order, retrains when due
        with psycopg.connect(dsn(), autocommit=True) as conn:
            conn.execute("LISTEN crm_revenue_inserted")
            print("listening for new orders…", flush=True)
            for _ in conn.notifies():
                with psycopg.connect(dsn()) as c2:
                    if due(c2): print(json.dumps(run_all("orders_threshold"), default=str), flush=True)
        return
    if a.if_due:
        with psycopg.connect(dsn()) as conn:
            if not ready(conn): print(json.dumps({"skipped": "program tables not migrated"})); return
            if not due(conn): print(json.dumps({"skipped": "not due"})); return
    print(json.dumps(run_all("orders_threshold" if a.if_due else "manual"), default=str, indent=2))

if __name__ == "__main__":
    main()
