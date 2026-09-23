#!/usr/bin/env bash
# =============================================================================
# Marketing Kit — HERMES installer.   bash install/hermes.sh   (re-run = update)
#
# Same seven components as install.sh, mapped to Hermes-native mechanisms:
#   kit skills      symlinked into ~/.hermes/skills/marketing/ (live from this checkout)
#   vendor skills   `hermes skills install <owner/repo/path>` + `hermes skills update` each run
#   humanizer       Hermes' bundled port of blader/humanizer (not installed twice)
#   MCP servers     mcp_servers.* via `hermes config set` — stdio through mkt-mcp (@latest),
#                   Resend via resend-mcp@latest · optional gsc/umami via mkt-settings
#   ledger          memory.provider = supermemory (local) + mkt-ledger
# =============================================================================
set -euo pipefail
SELF="${BASH_SOURCE[0]}"; while [ -L "$SELF" ]; do SELF="$(readlink "$SELF")"; done
KIT_ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
# shellcheck source=install/lib.sh
source "$KIT_ROOT/install/lib.sh"
HH="${HERMES_HOME:-$HOME/.hermes}"
SKILLS_DIR="$HH/skills/marketing"

say "── Marketing Kit · Hermes ───────────────────────────────"
kit_self_update "$KIT_ROOT"
HAVE_HERMES=0; command -v hermes >/dev/null 2>&1 && HAVE_HERMES=1
[ "$HAVE_HERMES" = 1 ] || warn "hermes CLI not on PATH — skills get linked; config steps are printed instead"

say "▶ runtimes"
ensure_runtime

say "▶ kit skills (symlinked — live from $KIT_ROOT)"
mkdir -p "$SKILLS_DIR"
for s in $KIT_SKILLS; do link_skill "$KIT_ROOT/skills/$s" "$SKILLS_DIR/$s"; done

say "▶ kit CLIs"
link_bins "$KIT_ROOT"
ensure_secrets_file "$KIT_ROOT"

ensure_supermemory_server
if [ "$HAVE_HERMES" = 1 ] && [ -s "$HOME/.supermemory/api-key" ]; then
    HPY="$(dirname "$(readlink -f "$(command -v hermes)")")/python"
    if [ -x "$HPY" ] && ! "$HPY" -c 'import supermemory' >/dev/null 2>&1; then
        "$HPY" -m pip install -q supermemory >/dev/null 2>&1 || uv pip install -q --python "$HPY" supermemory >/dev/null 2>&1 || warn "could not install the supermemory SDK into Hermes' venv"
    fi
    [ -f "$HH/supermemory.json" ] || printf '{\n  "base_url": "http://localhost:6767"\n}\n' > "$HH/supermemory.json"
    touch "$HH/.env"; chmod 600 "$HH/.env"
    grep -q '^SUPERMEMORY_API_KEY=' "$HH/.env" || printf 'SUPERMEMORY_API_KEY=%s\n' "$(cat "$HOME/.supermemory/api-key")" >> "$HH/.env"
    [ "$(hermes config get memory.provider 2>/dev/null)" = supermemory ] || hermes config set memory.provider supermemory >/dev/null 2>&1
    ok "memory.provider = supermemory (local)"
fi

say "▶ vendor skills (Hermes skills hub — installed from the vendor repo, updated every run)"
if [ "$HAVE_HERMES" = 1 ]; then
    LISTED="$(hermes skills list 2>/dev/null || true)"
    SKROOT="${HERMES_HOME:-$HOME/.hermes}/skills"
    while IFS=$'\t' read -r ident _ trust; do
        case "$ident" in ''|\#*) continue ;; esac
        name="${ident##*/}"
        have() { [ -n "$(find "$SKROOT" -maxdepth 3 -path "*/$1/SKILL.md" -print -quit 2>/dev/null)" ]; }
        if have "$name"; then ok "$name present"; continue; fi   # dir check: the list table truncates long names
        force=""; [ "$trust" = official ] && force="--force"
        out="$(hermes skills install "$ident" --category marketing --yes $force 2>&1)"
        # `hermes skills install` exits 0 even when its scanner blocks — trust the directory, not the exit code.
        if have "$name"; then
            ok "$name installed${force:+ (official vendor, scanner override)}"
        else
            warn "$name NOT installed: $(printf '%s' "$out" | grep -v '^ *$' | tail -1 | cut -c1-110)"
            warn "   inspect: hermes skills inspect $ident"
        fi
    done < "$KIT_ROOT/install/hermes-skills.tsv"
    hermes skills update >/dev/null 2>&1 && ok "hermes skills update (all hub skills at latest)" || warn "hermes skills update failed — run it manually"
    grep -qE "│ humanizer +│" <<<"$LISTED" && ok "humanizer (bundled)" || warn "bundled humanizer missing — hermes skills repair-official"
fi

say "▶ MCP servers (mcp_servers.*)"
mcp_set() {  # mcp_set <name> <json>
    if [ "$HAVE_HERMES" = 1 ]; then
        hermes config set "mcp_servers.$1" "$2" >/dev/null 2>&1 && ok "$1" || warn "$1: hermes config set failed — value: $2"
    else say "    hermes config set mcp_servers.$1 '$2'"; fi
}
MM="$MKT_BIN/mkt-mcp"
mcp_set crm-db "{\"command\": \"$MM\", \"args\": [\"db\", \"\${workspaceFolder}\"], \"timeout\": 120}"
command -v railway >/dev/null 2>&1 && mcp_set railway "{\"command\": \"$MM\", \"args\": [\"railway\"]}" || warn "railway skipped — install the railway CLI"
has_secret TELNYX_API_KEY && mcp_set telnyx "{\"command\": \"$MM\", \"args\": [\"telnyx\"]}" || warn "telnyx skipped — set TELNYX_API_KEY in $MKT_SECRETS, re-run"
has_secret UMAMI_DATABASE_URL && mcp_set umami "{\"command\": \"$MM\", \"args\": [\"umami\"], \"timeout\": 120}" || warn "umami skipped — core web analytics not deployed yet: mkt-umami deploy (in an app repo), re-run"
has_secret RESEND_API_KEY && mcp_set resend "{\"command\": \"$MM\", \"args\": [\"resend\"]}" || warn "resend skipped — set RESEND_API_KEY in $MKT_SECRETS, re-run"
if [ "$HAVE_HERMES" = 1 ]; then
    # retired sources (first-party only): drop anything an older kit version registered
    for r in ga4 posthog stripe; do hermes mcp remove "$r" </dev/null >/dev/null 2>&1 && say "  · $r removed (retired: data is first-party now)"; done
    SKROOT="${HERMES_HOME:-$HOME/.hermes}/skills"
    [ -L "$SKROOT/marketing/stripe-best-practices" ] || [ -d "$SKROOT/marketing/stripe-best-practices" ] \
        && hermes skills uninstall stripe-best-practices --yes >/dev/null 2>&1 && say "  · stripe-best-practices skill removed (retired)"
    say "▶ optional sources (your switches: mkt-settings)"
    MKT_MCP="$MM" bash "$KIT_ROOT/bin/mkt-settings" apply hermes
fi

say "▶ living updates (session start = the event; no timers)"
if [ "$HAVE_HERMES" = 1 ]; then
    case "$(wire_hermes_update_hook)" in
        added) ok "on_session_start → mkt-update --hook (existing hooks kept)"
               say "    Hermes asks once before running a new hook — approve it the first time you start hermes in a terminal" ;;
        present) ok "on_session_start → mkt-update --hook already wired" ;;
        *) warn "could not wire on_session_start hook — see hermes hooks --help" ;;
    esac
fi
write_kit_version "$KIT_ROOT" "$HH"
say "─── done ───────────────────────────────────────────────"
say "Start a NEW Hermes session. Then:  mkt-doctor   ·   in each app repo:  mkt-init"
