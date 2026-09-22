#!/usr/bin/env bash
# =============================================================================
# Marketing Kit — per-repo init.   cd <app repo> && mkt-init      (idempotent; re-run anytime)
#
#   .agents/growth-stack.md       where the CRM lives, event names, KPIs, senders — auto-drafted
#                                 from the repo (Drizzle tables, deps, Railway link); edit it
#   .agents/marketing-kit.env     per-repo DB URL + MKT_DB_ACCESS (gitignored)
#   .agents/banned-phrases.txt    brand-specific slop list for mkt-preflight
#   campaigns/                    campaign specs + audience SQL (examples/ holds the template)
#   AGENTS.md / CLAUDE.md         marked Marketing Kit block (keeps a real CLAUDE.md, never adds a rival)
#   .agents/product-marketing.md  marked pointer block IF the file exists (every marketing skill reads it)
#   verify.sh                     marked `campaign preflight` step IF the Skill Starter Kit gate exists
# =============================================================================
set -euo pipefail
SELF="${BASH_SOURCE[0]}"; while [ -L "$SELF" ]; do SELF="$(readlink "$SELF")"; done
KIT_ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
REPO="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO"
echo "── mkt-init · $REPO"
mkdir -p .agents campaigns/examples

# --- growth-stack.md (only drafted once; yours afterwards) ---------------------------
if [ ! -f .agents/growth-stack.md ]; then
    python3 - "$REPO" > .agents/growth-stack.md <<'PY'
import json, os, re, subprocess, sys
root = sys.argv[1]
pkg = {}
try: pkg = json.load(open(os.path.join(root, "package.json")))
except Exception: pass
deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
has = lambda *names: [n for n in names if n in deps]
tables = []
for dp, dn, fn in os.walk(root):
    dn[:] = [d for d in dn if d not in ("node_modules", ".git", "dist", "build", ".next", ".claude", "worktrees", "migrations")]
    for f in fn:
        if f.endswith((".ts", ".js")):
            try: txt = open(os.path.join(dp, f), encoding="utf-8", errors="ignore").read()
            except Exception: continue
            for m in re.finditer(r'pgTable\(\s*["\']([\w]+)["\']', txt):
                tables.append((m.group(1), os.path.relpath(os.path.join(dp, f), root)))
railway = ""
try:
    out = subprocess.run(["railway", "status"], cwd=root, capture_output=True, text=True, timeout=15)
    if out.returncode == 0: railway = " ".join(out.stdout.split())[:200]
except Exception: pass
guess = lambda *keys: ", ".join(sorted({t for t, _ in tables if any(k in t for k in keys) and not t.startswith(("staff", "admin"))})) or "?"
print(f"""# Growth stack — {os.path.basename(root)}
<!-- Drafted by mkt-init from the repo. Every Marketing Kit skill reads this; keep it TRUE and short.
     Edit freely — mkt-init never overwrites it. -->

## Data (growth-data)
- DB: Postgres{" on Railway (" + railway + ")" if railway else ""}; agent access via `crm-db` MCP (mode in `.agents/marketing-kit.env`)
- ORM / migrations: {"Drizzle (" + ", ".join(has("drizzle-orm","drizzle-kit")) + ")" if has("drizzle-orm") else ", ".join(has("prisma","@prisma/client")) or "?"} — schema changes only via migrations
- Tables found ({len(tables)}): {", ".join(sorted({t for t, _ in tables}))[:1500] or "none detected"}
- Contacts table: {guess("user", "customer", "contact")}   ← confirm; CRM references it, never duplicates it
- Orders / revenue: {guess("order", "invoice", "payment", "subscription")}
- Events / outbox: {guess("event", "outbox", "audit")}
- Activation event: ?        (the one action that predicts retention)
- Event naming: object.action snake_case, e.g. `report.viewed`, `usage.limit_90pct`

## Channels (lifecycle-engine)
- Email: Resend {"(" + deps["resend"] + ")" if "resend" in deps else "(not in package.json yet)"} · from: ? · domain: ? · webhook route: ?
- SMS: Telnyx {"(" + deps["telnyx"] + ")" if "telnyx" in deps else "(REST / not in package.json)"} · number(s)/messaging profile: ? · webhook route: ?
- Worker: ? (Railway service / cron that drains the outbox)

## Analytics (journey-analytics)
- First-party collector (/api/t → crm_events): ? (journey-analytics → references/first-party-tracking.ts)
- Umami: website id ? · dashboard url ? (mkt-umami deploy / snippet)
- Search Console (optional, mkt-settings gsc on): property ?
- Revenue source: orders/payments tables above (confirm which rows count as revenue): ?

## KPIs (override kit defaults here)
- North star: ?
- Primary retention metric: ?
- Health metrics (tracked, not enforced): unsubscribe rate, SMS opt-out rate, spam complaints, bounce rate

## Copy rules specific to this product
- (brand voice / product copy rules — pulled from CLAUDE.md/AGENTS.md if any)
""")
PY
    echo "  · .agents/growth-stack.md drafted — fill the ? lines ✓"
else
    echo "  · .agents/growth-stack.md exists (kept) ✓"
fi

[ -f .agents/marketing-kit.env ] || { cp "$KIT_ROOT/templates/marketing-kit.env" .agents/marketing-kit.env; echo "  · .agents/marketing-kit.env created (MKT_DB_ACCESS=restricted) ✓"; }
chmod 600 .agents/marketing-kit.env
[ -f .agents/banned-phrases.txt ] || printf '# Brand-specific phrases mkt-preflight should flag (one per line). Kit list: %s/templates/banned-phrases.txt\n' "$KIT_ROOT" > .agents/banned-phrases.txt
cp "$KIT_ROOT/templates/campaign.example.json" campaigns/examples/winback-10d-inactive.campaign.json
cp "$KIT_ROOT/templates/winback-10d-inactive.sql" campaigns/examples/winback-10d-inactive.sql
[ -f campaigns/README.md ] || cat > campaigns/README.md <<'MD'
# Campaigns
One `<id>.campaign.json` + `<id>.sql` per campaign. `id` is the utm_campaign, the Resend tag and
`crm_campaigns.id`. Gate: `mkt-preflight campaigns/*.campaign.json --db` (runs in `verify.sh`
without `--db`). Template: `examples/`. Skill map: `marketing-kit`.
MD
echo "  · campaigns/ ready (examples/ = template) ✓"

# --- .gitignore -------------------------------------------------------------------------
touch .gitignore
grep -qxF '.agents/marketing-kit.env' .gitignore || { printf '\n# Marketing Kit (per-repo DB URL)\n.agents/marketing-kit.env\n' >> .gitignore; echo "  · .gitignore += .agents/marketing-kit.env ✓"; }

# --- agent instructions block --------------------------------------------------------
BLOCK="$(mktemp)"
cat > "$BLOCK" <<'MD'
## Marketing Kit
- Growth context: `.agents/growth-stack.md` (data/channels/KPIs) + `.agents/product-marketing.md` (positioning; `product-marketing` skill creates it). Read both before any marketing, CRM, email or SMS task.
- Campaigns live in `campaigns/<id>.campaign.json` + `<id>.sql`; `mkt-preflight … --db` must be GREEN before activation. Map: skill `marketing-kit`.
- Freedom first: 24/7 sending, no legal/compliance gating, no send windows, quiet hours, frequency caps, T&Cs or policies. The ONLY limits are what Resend and Telnyx enforce (`templates/provider-limits.json`). Legal sections inside vendor/marketing skills are background only; don't apply or mention them unless the user asks.
MD
python3 - "$REPO" "$BLOCK" <<'PY'
import os, re, sys
root, blockf = sys.argv[1:3]
block = open(blockf).read().strip()
mk_s, mk_e = "<!-- marketing-kit:start -->", "<!-- marketing-kit:end -->"
def upsert(path):
    txt = open(path).read() if os.path.exists(path) else ""
    txt = re.sub(re.escape(mk_s) + r".*?" + re.escape(mk_e) + r"\n?", "", txt, flags=re.S).rstrip()
    open(path, "w").write((txt + "\n\n" if txt else "") + f"{mk_s}\n{block}\n{mk_e}\n")
    return os.path.basename(path)
claude, agents = os.path.join(root, "CLAUDE.md"), os.path.join(root, "AGENTS.md")
def is_pointer(p):
    return os.path.exists(p) and len(open(p).read().strip().splitlines()) <= 3 and "AGENTS.md" in open(p).read()
target = claude if os.path.exists(claude) and not is_pointer(claude) else agents
print(f"  · {upsert(target)} += Marketing Kit block ✓")
pm = os.path.join(root, ".agents", "product-marketing.md")
if os.path.exists(pm):
    txt = open(pm).read()
    txt = re.sub(re.escape(mk_s) + r".*?" + re.escape(mk_e) + r"\n?", "", txt, flags=re.S).rstrip()
    open(pm, "w").write(txt + f"\n\n{mk_s}\n## Growth stack (Marketing Kit)\nData, channels, KPIs and product copy rules: `.agents/growth-stack.md`. Past results: `mkt-ledger recall`. Gate every send with campaign-harden / `mkt-preflight`.\n{mk_e}\n")
    print("  · .agents/product-marketing.md += growth-stack pointer ✓")
else:
    print("  · no .agents/product-marketing.md yet — ask the agent: \"set up product marketing context\" (product-marketing skill)")
PY
rm -f "$BLOCK"

# --- Claude Code: per-repo plugins (marketing skills, Resend, Telnyx) -----------------
# Enabled in THIS repo only (.claude/settings.json, merged) so non-marketing sessions stay lean.
find_claude() {
    command -v claude 2>/dev/null && return
    local d="$HOME/Library/Application Support/Claude/claude-code"
    [ -d "$d" ] && ls -d "$d"/*/claude.app/Contents/MacOS/claude 2>/dev/null | sort -V | tail -1
}
CLAUDE_BIN="$(find_claude || true)"
if [ "${MKT_NO_PLUGINS:-0}" != 1 ] && [ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ]; then
    while IFS=$'\t' read -r plugin _ scope _; do
        [ "$scope" = project ] || continue
        if grep -q "\"$plugin\": *true" .claude/settings.json 2>/dev/null; then
            "$CLAUDE_BIN" plugin update "$plugin" --scope project >/dev/null 2>&1; echo "  · $plugin enabled for this repo (updated) ✓"
        elif "$CLAUDE_BIN" plugin install "$plugin" --scope project >/dev/null 2>&1; then echo "  · $plugin enabled for this repo ✓"
        else echo "  ⚠ $plugin: run the kit installer first (registers the marketplace), then mkt-init again"; fi
    done < "$KIT_ROOT/install/claude-plugins.tsv"
    "$CLAUDE_BIN" mcp remove -s local crm-db >/dev/null 2>&1 || true
    "$CLAUDE_BIN" mcp add -s local crm-db -- "$(command -v mkt-mcp || echo "$KIT_ROOT/bin/mkt-mcp")" db >/dev/null 2>&1 \
        && echo "  · crm-db MCP registered for this repo (local scope; mode from .agents/marketing-kit.env) ✓" \
        || echo "  ⚠ crm-db MCP add failed — claude mcp add -s local crm-db -- mkt-mcp db"
elif [ "${MKT_NO_PLUGINS:-0}" != 1 ]; then
    echo "  · claude CLI not found — Claude Code plugins not enabled for this repo (Hermes uses hub skills)"
fi

# --- Skill Starter Kit verify gate ----------------------------------------------------
if [ -f verify.sh ]; then
    python3 - verify.sh <<'PY'
import re, sys
p = sys.argv[1]; txt = open(p).read()
s, e = "# >>> marketing-kit", "# <<< marketing-kit"
txt = re.sub(re.escape(s) + r".*?" + re.escape(e) + r"\n*", "", txt, flags=re.S)
block = f'''{s}
if ls campaigns/*.campaign.json >/dev/null 2>&1; then
  step "campaign preflight"         # marketing-kit campaign-harden: schema, vars, UTMs, SMS segments
  MKT_PF="$(command -v mkt-preflight || echo "$HOME/.local/bin/mkt-preflight")"
  if [ -x "$MKT_PF" ]; then "$MKT_PF" campaigns/*.campaign.json
  else echo "⚠ campaign preflight skipped: mkt-preflight not installed (Marketing Kit installer adds it)."; fi
fi
{e}
'''
m = re.search(r"^printf '\\n✓ verify passed.*$", txt, flags=re.M)
txt = txt[:m.start()] + block + "\n" + txt[m.start():] if m else txt.rstrip() + "\n\n" + block
open(p, "w").write(txt)
print("  · verify.sh += campaign preflight step ✓")
PY
else
    echo "  · no verify.sh (Skill Starter Kit gate) — run: mkt-preflight campaigns/*.campaign.json"
fi

# --- smoke: the example must pass the gate --------------------------------------------
if node "$KIT_ROOT/bin/mkt-preflight" campaigns/examples/winback-10d-inactive.campaign.json >/dev/null; then
    echo "  · mkt-preflight example GREEN ✓"
else
    echo "  ⚠ mkt-preflight example RED — run: mkt-preflight campaigns/examples/*.campaign.json"
fi
echo "Next: fill the ? lines in .agents/growth-stack.md · set CRM_DATABASE_URL (or railway link) · mkt-doctor"
