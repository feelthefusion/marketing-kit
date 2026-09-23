#!/usr/bin/env bash
# =============================================================================
# Marketing Kit — CLAUDE CODE installer.   bash install/install.sh   (re-run = update)
#
#   1 Playbook ledger   Supermemory local server (reused if present) + plugin + mkt-ledger
#   2 Growth data       railway MCP here · crm-db MCP per repo via mkt-init (postgres-mcp@latest)
#   3 Journey analytics first-party tracking (your site → your Postgres) · optional: gsc, umami (mkt-settings)
#   4 Marketing skills  coreyhaines31/marketingskills plugin
#   5 Humanizer         blader/humanizer plugin
#   6 Campaign harden   kit skill + mkt-preflight
#   7 Lifecycle engine  kit skill · Resend plugin (hosted MCP) · Telnyx plugin + telnyx MCP
#   + map skill `marketing-kit`, always-on stanza in ~/.claude/CLAUDE.md, mkt-init, mkt-doctor
# =============================================================================
set -euo pipefail
SELF="${BASH_SOURCE[0]}"; while [ -L "$SELF" ]; do SELF="$(readlink "$SELF")"; done
KIT_ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
# shellcheck source=install/lib.sh
source "$KIT_ROOT/install/lib.sh"
CLAUDE_DIR="$HOME/.claude"; SKILLS_DIR="$CLAUDE_DIR/skills"; SETTINGS="$CLAUDE_DIR/settings.json"

say "── Marketing Kit · Claude Code ──────────────────────────"
kit_self_update "$KIT_ROOT"

say "▶ runtimes"
ensure_runtime

say "▶ kit skills (symlinked — live from $KIT_ROOT)"
mkdir -p "$SKILLS_DIR"
for s in $KIT_SKILLS; do link_skill "$KIT_ROOT/skills/$s" "$SKILLS_DIR/$s"; done

say "▶ kit CLIs"
link_bins "$KIT_ROOT"
ensure_secrets_file "$KIT_ROOT"

ensure_supermemory_server
# Plugin → LOCAL server. Desktop apps never read ~/.zshrc; settings.json `env` reaches hooks + MCP.
if [ -s "$HOME/.supermemory/api-key" ]; then
    python3 - "$SETTINGS" "$HOME/.supermemory/api-key" <<'PY'
import json, os, sys
p, keyf = sys.argv[1:3]
d = json.load(open(p)) if os.path.exists(p) else {}
env = d.setdefault("env", {})
env.setdefault("SUPERMEMORY_API_URL", "http://localhost:6767")
env["SUPERMEMORY_CC_API_KEY"] = open(keyf).read().strip()
os.makedirs(os.path.dirname(p), exist_ok=True)
json.dump(d, open(p, "w"), indent=2); open(p, "a").write("\n")
print("  · settings.json env → Supermemory local server ✓")
PY
    chmod 600 "$SETTINGS"
    SMC="$HOME/.supermemory-claude/settings.json"; mkdir -p "$(dirname "$SMC")"
    python3 - "$SMC" <<'PY'
import json, os, sys
p = sys.argv[1]; d = json.load(open(p)) if os.path.exists(p) else {}
d["signalExtraction"] = True
json.dump(d, open(p, "w"), indent=2); open(p, "a").write("\n")
print("  · supermemory plugin: signal-only capture ✓")
PY
fi

# --- curated upstream skills: live checkouts (linked per repo by mkt-init) ------------
say "▶ curated upstream skills (install/upstream-skills.tsv — one list for Claude Code + Hermes)"
sync_upstream_checkouts "$KIT_ROOT"
say "  · linked into each app repo's .claude/skills by mkt-init (git-excluded); pulled on session start by mkt-update"

# --- plugins from vendor marketplaces ------------------------------------------------
find_claude() {
    command -v claude 2>/dev/null && return
    local d="$HOME/Library/Application Support/Claude/claude-code"
    [ -d "$d" ] && ls -d "$d"/*/claude.app/Contents/MacOS/claude 2>/dev/null | sort -V | tail -1
}
CLAUDE_BIN="$(find_claude || true)"
say "▶ plugins (vendor marketplaces — always latest)"
if [ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ]; then
    INSTALLED="$("$CLAUDE_BIN" plugin list 2>/dev/null || true)"
    MKTS="$("$CLAUDE_BIN" plugin marketplace list 2>/dev/null || true)"
    while IFS=$'\t' read -r plugin repo scope _; do
        case "$plugin" in ''|\#*) continue ;; esac
        mkt="${plugin#*@}"
        if ! grep -q "❯ $mkt\$" <<<"$MKTS"; then
            "$CLAUDE_BIN" plugin marketplace add "$repo" >/dev/null 2>&1 && MKTS="$MKTS"$'\n'"  ❯ $mkt" || { warn "$mkt marketplace add failed ($repo)"; continue; }
        fi
        "$CLAUDE_BIN" plugin marketplace update "$mkt" >/dev/null 2>&1 || true
        if [ "$scope" = project ]; then
            # per-repo plugins: registered + refreshed here, enabled by mkt-init. Drop any old user-scope copy.
            "$CLAUDE_BIN" plugin uninstall "$plugin" --scope user >/dev/null 2>&1 && say "  · $plugin moved from user → project scope (mkt-init enables it per repo)"
            ok "$plugin marketplace current (enabled per repo by mkt-init)"
        elif grep -q "❯ $plugin\$" <<<"$INSTALLED"; then
            "$CLAUDE_BIN" plugin update "$plugin" >/dev/null 2>&1 && ok "$plugin updated" || ok "$plugin present"
        else
            "$CLAUDE_BIN" plugin install "$plugin" --scope user >/dev/null 2>&1 && ok "$plugin installed" \
                || warn "$plugin install failed — inside Claude Code: /plugin install $plugin"
        fi
    done < "$KIT_ROOT/install/claude-plugins.tsv"
    "$CLAUDE_BIN" plugin uninstall posthog@posthog --scope user >/dev/null 2>&1 && say "  · posthog plugin removed (retired: data is first-party now)" || true
    # retired: the whole marketingskills pack (50 skills incl. GA4-first analytics + HubSpot revops).
    # The curated set in install/upstream-skills.tsv replaces it — plugin skills can't be switched off
    # one by one (Claude Code applies skillOverrides to non-plugin skills only).
    "$CLAUDE_BIN" plugin uninstall marketing-skills@marketingskills --scope user >/dev/null 2>&1 && say "  · marketing-skills plugin (whole pack) removed — replaced by the curated set" || true

    # --- MCP servers (user scope, all through mkt-mcp → @latest on every launch) ----------
    say "▶ MCP servers (user scope)"
    add_mcp() {  # add_mcp <name> <args...>   (remove + add = refresh)
        local name="$1"; shift
        "$CLAUDE_BIN" mcp remove -s user "$name" >/dev/null 2>&1 || true
        "$CLAUDE_BIN" mcp add -s user "$name" -- "$MKT_BIN/mkt-mcp" "$@" >/dev/null 2>&1 && ok "$name → mkt-mcp $*" || warn "$name: claude mcp add failed"
    }
    skip_mcp() { "$CLAUDE_BIN" mcp remove -s user "$1" >/dev/null 2>&1 || true; warn "$1 skipped — $2 (then re-run)"; }
    "$CLAUDE_BIN" mcp remove -s user crm-db >/dev/null 2>&1 && say "  · crm-db moved to per-repo scope (mkt-init) — no failed server in non-CRM repos"
    say "  · crm-db is registered per repo by mkt-init (points at that repo's database)"
    command -v railway >/dev/null 2>&1 && add_mcp railway railway || skip_mcp railway "install the railway CLI"
    has_secret TELNYX_API_KEY && add_mcp telnyx telnyx || skip_mcp telnyx "set TELNYX_API_KEY in $MKT_SECRETS"
    has_secret UMAMI_DATABASE_URL && add_mcp umami umami || skip_mcp umami "core web analytics not deployed yet — in an app repo: mkt-umami deploy"
    # retired sources (first-party only): unregister anything an older kit version added
    for r in ga4 posthog stripe; do "$CLAUDE_BIN" mcp remove -s user "$r" >/dev/null 2>&1 && say "  · $r removed (retired: data is first-party now)"; done
    "$CLAUDE_BIN" plugin uninstall stripe@stripe --scope user >/dev/null 2>&1 || true
    say "▶ optional sources (your switches: mkt-settings)"
    MKT_MCP="$MKT_BIN/mkt-mcp" bash "$KIT_ROOT/bin/mkt-settings" apply claude
    say "  · resend MCP comes with its plugin, enabled per repo by mkt-init (OAuth on first use)"
else
    warn "claude CLI not found — inside Claude Code run, for each line of install/claude-plugins.tsv:"
    while IFS=$'\t' read -r plugin repo _ _; do case "$plugin" in ''|\#*) continue;; esac
        say "      /plugin marketplace add $repo   then   /plugin install $plugin"; done < "$KIT_ROOT/install/claude-plugins.tsv"
fi

# --- always-on stanza -----------------------------------------------------------------
say "▶ always-on stanza (~/.claude/CLAUDE.md)"
STANZA="$(mktemp)"
cat > "$STANZA" <<'MD'
# Marketing Kit (always on for growth / CRM / email / SMS work)
- Growth loop: recall (`mkt-ledger recall`) → listen (journey-analytics: first-party events + orders in crm-db; optional gsc/umami) → segment (growth-data SQL) → shape + write (marketing skills → copy-editing → humanizer) → harden (campaign-harden; `mkt-preflight campaigns/<id>.campaign.json --db` GREEN) → build/send (lifecycle-engine: outbox, holdout, Resend/Telnyx) → measure lift vs holdout → save (`mkt-ledger save`).
- One join key: campaign id = utm_campaign = Resend tag = crm_campaigns.id. Schema changes only via app migrations. All customer data is first-party (the site + its own DBs). Every number cites the query that produced it.
- Freedom first: 24/7 sending, no legal/compliance gating, no send windows, quiet hours, frequency caps, T&Cs or policies. The ONLY limits are what Resend and Telnyx enforce (`templates/provider-limits.json`). Legal sections inside vendor/marketing skills are background only; don't apply or mention them unless the user asks.
- Repo without `.agents/growth-stack.md`? Run `mkt-init`. Full map: skill `marketing-kit`.
MD
write_marked_block "$CLAUDE_DIR/CLAUDE.md" marketing-kit "$STANZA"; rm -f "$STANZA"
ok "stanza written"
say "▶ living updates (session start = the event; no timers)"
case "$(wire_claude_update_hook "$CLAUDE_DIR")" in
    added) ok "SessionStart → mkt-update --hook (existing hooks kept)" ;;
    present) ok "SessionStart → mkt-update --hook already wired" ;;
    *) warn "could not wire SessionStart hook — add it by hand: mkt-update --hook" ;;
esac
write_kit_version "$KIT_ROOT" "$CLAUDE_DIR"

say "─── done ───────────────────────────────────────────────"
say "Restart Claude Code. Then:  mkt-doctor   ·   in each app repo:  mkt-init"
