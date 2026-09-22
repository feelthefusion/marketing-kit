#!/usr/bin/env python3
"""Run every numbered query in analytics.sql (app-DB part) and cohorts.sql against a seeded DB.
Usage: sql_check.py <dbname> <kit-root>. Exits 1 if any query errors; prints one line per query."""
import re, subprocess, sys
db, kit = sys.argv[1], sys.argv[2]
VARS = ["-v", "activation_event=onboarding.completed", "-v", "success_event=order.paid",
        "-v", "campaign_id=winback-10d-inactive", "-v", "window_days=14"]
failed = 0
def run(path, stop=None):
    global failed
    s = open(path).read()
    if stop: s = s.split(stop)[0]
    for c in re.split(r"\n(?=-- ?[0-9A-Za-z#]+[.)] )", s):
        body = "\n".join(l for l in c.splitlines() if not l.strip().startswith("--")).strip()
        if not body: continue
        title = c.strip().splitlines()[0][:64]
        r = subprocess.run(["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", *VARS, "-At", db],
                           input=body, capture_output=True, text=True)
        if r.returncode: failed += 1; print("ERR", title, "→", r.stderr.strip()[:160])
        else: print("OK ", title, "→", len([l for l in r.stdout.splitlines() if l.strip()]), "rows")
run(f"{kit}/skills/journey-analytics/references/analytics.sql", stop="-- ─── Umami DB")
run(f"{kit}/skills/growth-data/references/cohorts.sql")
sys.exit(1 if failed else 0)
