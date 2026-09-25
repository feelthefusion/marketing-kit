#!/usr/bin/env bash
# =============================================================================
# Marketing Kit — shared installer library (sourced by install.sh / hermes.sh)
#
# LIVE BY DESIGN — nothing third-party is cloned or copied into this repo:
#   * kit skills      → SYMLINKED from this checkout (bootstrap pulls it every run)
#   * curated upstream → install/upstream-skills.tsv, ONE list for both hosts. Claude Code:
#                        shallow checkouts in $MKT_UPSTREAM (pulled by mkt-update on session
#                        start) SYMLINKED per repo by mkt-init; Hermes: hub installs + `hermes
#                        skills update`. Only listed skills exist → nothing duplicates.
#   * vendor packs     → Claude Code: plugins from each vendor's own marketplace, updated
#                        every run;  Hermes: hub installs from the vendor repo (hermes-skills.tsv)
#   * MCP servers     → `mkt-mcp <name>` launches `pkg@latest` on every start
# =============================================================================

MKT_BIN="$HOME/.local/bin"
MKT_CONF="$HOME/.config/marketing-kit"
MKT_SECRETS="$MKT_CONF/secrets.env"
KIT_SKILLS="marketing-kit growth-data journey-analytics campaign-harden lifecycle-engine playbook-ledger partner-program loyalty-engine growth-optimizer meta-ads mobile-growth"
MKT_UPSTREAM="${MKT_UPSTREAM:-${XDG_DATA_HOME:-$HOME/.local/share}/marketing-kit/upstream}"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  · %s ✓\n' "$*"; }
warn() { printf '  ⚠ %s\n' "$*"; }

kit_self_update() {  # $1 = kit root
    local root="$1" before after
    [ "${KIT_NO_PULL:-0}" = 1 ] && { say "▶ self-update skipped (KIT_NO_PULL=1)"; return 0; }
    git -C "$root" rev-parse --git-dir >/dev/null 2>&1 || { say "▶ self-update skipped — not a git clone"; return 0; }
    say "▶ self-update: pulling latest Marketing Kit"
    if [ -n "$(git -C "$root" status --porcelain)" ]; then warn "local changes — not pulling (commit/stash to get updates)"; return 0; fi
    before="$(git -C "$root" rev-parse --short HEAD)"
    git -C "$root" pull --ff-only --quiet 2>/dev/null || { warn "pull failed (offline/diverged) — using local copy"; return 0; }
    after="$(git -C "$root" rev-parse --short HEAD)"
    [ "$before" = "$after" ] && ok "already at latest ($after)" || ok "updated $before → $after"
}

# Symlink one kit skill dir into a host skills dir (live link, never a copy).
link_skill() {  # link_skill <src-dir> <dst-dir>
    local src="$1" dst="$2"
    if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then ok "$(basename "$dst") linked"; return 0; fi
    [ -e "$dst" ] && rm -rf "$dst"          # replace a stale copy/old link
    ln -s "$src" "$dst" && ok "$(basename "$dst") → $src"
}

# ---- curated upstream skills (install/upstream-skills.tsv) ----------------------------------
upstream_rows()  { grep -v '^#' "$1/install/upstream-skills.tsv" | awk -F'\t' 'NF>=3'; }   # ident hosts trust owns
upstream_repos() { upstream_rows "$1" | cut -f1 | cut -d/ -f1-2 | sort -u; }
upstream_dir()   { printf '%s/%s\n' "$MKT_UPSTREAM" "$(printf '%s' "$1" | tr '/' '_')"; }

# Clone or fast-forward every upstream repo (shallow, one commit deep: always the latest HEAD).
sync_upstream_checkouts() {  # $1 = kit root
    local base="${MKT_GIT_BASE:-https://github.com}" repo d
    mkdir -p "$MKT_UPSTREAM"
    for repo in $(upstream_repos "$1"); do
        d="$(upstream_dir "$repo")"
        if [ -d "$d/.git" ]; then
            if git -C "$d" fetch --depth 1 --quiet origin HEAD 2>/dev/null && git -C "$d" reset --hard --quiet FETCH_HEAD; then
                ok "$repo @ $(git -C "$d" rev-parse --short HEAD)"
            else warn "$repo: fetch failed — keeping $(git -C "$d" rev-parse --short HEAD 2>/dev/null)"; fi
        else
            git clone --depth 1 --quiet "$base/$repo.git" "$d" 2>/dev/null && ok "$repo cloned @ $(git -C "$d" rev-parse --short HEAD)" \
                || warn "$repo: clone failed (offline?) — re-run the installer"
        fi
    done
}

# Link the curated skills for one host into a skills dir; prune links to skills no longer listed.
# Never touches a real (non-symlink) dir of the same name — that is the user's own skill.
link_upstream_skills() {  # $1 = kit root  $2 = skills dir  $3 = host (claude|hermes)
    local ident hosts repo path n src linked=0 missing=0 l
    mkdir -p "$2"
    while IFS=$'\t' read -r ident hosts _; do
        case "$hosts" in both|"$3") ;; *) continue ;; esac
        repo="$(printf '%s' "$ident" | cut -d/ -f1-2)"; path="$(printf '%s' "$ident" | cut -d/ -f3-)"; n="${ident##*/}"
        src="$(upstream_dir "$repo")/$path"
        if [ ! -f "$src/SKILL.md" ]; then missing=$((missing+1)); continue; fi
        if [ -e "$2/$n" ] && [ ! -L "$2/$n" ]; then warn "$n: a real skill dir exists in $2 — left as is"; continue; fi
        ln -sfn "$src" "$2/$n"; linked=$((linked+1))
    done < <(upstream_rows "$1")
    for l in "$2"/*; do   # prune: links into the upstream store that the manifest no longer lists
        [ -L "$l" ] || continue
        case "$(readlink "$l")" in "$MKT_UPSTREAM"/*) ;; *) continue ;; esac
        upstream_rows "$1" | cut -f1 | grep -q "/$(basename "$l")\$" || { rm -f "$l"; say "  · $(basename "$l") unlinked (no longer in the curated set)"; }
    done
    ok "$linked curated upstream skills linked into $2"
    [ "$missing" -gt 0 ] && warn "$missing listed skills not in the local checkouts — run the kit installer (it clones them)"
    return 0
}

link_bins() {  # $1 = kit root
    mkdir -p "$MKT_BIN"
    local b
    for b in mkt-mcp mkt-ledger mkt-preflight mkt-doctor mkt-settings mkt-update mkt-webhooks mkt-optimize; do
        chmod +x "$1/bin/$b"; ln -sfn "$1/bin/$b" "$MKT_BIN/$b"
    done
    for b in mkt-umami; do   # retired CLIs: drop the stale link (Umami left the stack; crm_events is the only analytics store)
        [ -L "$MKT_BIN/$b" ] && rm -f "$MKT_BIN/$b" && say "  · $b removed (retired)"
    done
    chmod +x "$1/install/init-project.sh"; ln -sfn "$1/install/init-project.sh" "$MKT_BIN/mkt-init"
    ok "mkt-mcp mkt-ledger mkt-preflight mkt-doctor mkt-settings mkt-update mkt-webhooks mkt-optimize mkt-init → $MKT_BIN"
    case ":$PATH:" in *":$MKT_BIN:"*) ;; *) warn "$MKT_BIN is not on PATH — add: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;; esac
}

ensure_secrets_file() {  # $1 = kit root
    mkdir -p "$MKT_CONF"; chmod 700 "$MKT_CONF"
    if [ ! -f "$MKT_SECRETS" ]; then
        cp "$1/templates/secrets.env.example" "$MKT_SECRETS"
        ok "created $MKT_SECRETS (fill in keys, then re-run to register those MCP servers)"
    else
        ok "secrets file present ($MKT_SECRETS)"
    fi
    chmod 600 "$MKT_SECRETS"
}

has_secret() {  # has_secret KEY → 0 when set (env or secrets file)
    [ -n "${!1:-}" ] && return 0
    [ -f "$MKT_SECRETS" ] && grep -qE "^$1=.+" "$MKT_SECRETS"
}

ensure_runtime() {
    command -v node >/dev/null 2>&1 && ok "node $(node -v)" || warn "node missing — install Node 20+ (npx servers + mkt-preflight need it)"
    if command -v uvx >/dev/null 2>&1; then ok "uv $(uv --version 2>/dev/null | awk '{print $2}')"
    else
        say "  · installing uv (runs postgres-mcp and, if enabled, mcp-search-console)"
        curl -LsSf https://astral.sh/uv/install.sh 2>/dev/null | env UV_INSTALL_DIR="$MKT_BIN" sh >/dev/null 2>&1 \
            && ok "uv installed → $MKT_BIN" || warn "uv install failed — https://docs.astral.sh/uv/"
    fi
    if command -v railway >/dev/null 2>&1; then ok "railway $(railway --version 2>/dev/null | awk '{print $NF}')"
    elif command -v brew >/dev/null 2>&1; then brew install railway >/dev/null 2>&1 && ok "railway installed (brew)" || warn "railway install failed"
    else bash <(curl -fsSL https://railway.com/install.sh) >/dev/null 2>&1 && ok "railway installed" || warn "railway install failed — https://docs.railway.com/cli"
    fi
    command -v psql >/dev/null 2>&1 && ok "psql present (mkt-preflight --db)" || warn "psql missing — mkt-preflight --db skips the live column check (brew install libpq / apt install postgresql-client)"
}

# Supermemory LOCAL server: reuse when present (Skill Starter Kit installs it), install when not.
ensure_supermemory_server() {
    say "▶ Supermemory (playbook ledger)"
    if curl -s -o /dev/null --max-time 3 http://localhost:6767/ 2>/dev/null; then
        ok "local server answering on :6767 (already installed — wiring only)"
    else
        if [ ! -x "$HOME/.local/bin/supermemory-server" ]; then
            say "  · installing supermemory-server (official installer)"
            # The installer prompts on /dev/tty for an LLM key; headless shells (CI, containers) can't
            # open it, so skip the prompt there — search works without a key, extraction needs one.
            local np=""; ( : </dev/tty ) 2>/dev/null || np=1
            curl -fsSL https://supermemory.ai/install | SUPERMEMORY_NO_PROMPT="${np:-${SUPERMEMORY_NO_PROMPT:-}}" bash >/dev/null 2>&1 \
                && ok "supermemory-server installed" \
                || { warn "Supermemory install failed — see https://supermemory.ai/install"; return 0; }
        fi
        if [ "$(uname -s)" = Darwin ]; then
            local agent="$HOME/Library/LaunchAgents/com.supermemory.local.plist"
            if [ ! -f "$agent" ]; then
                mkdir -p "$(dirname "$agent")" "$HOME/.supermemory"
                cat > "$agent" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
    <key>Label</key><string>com.supermemory.local</string>
    <key>ProgramArguments</key><array><string>$HOME/.local/bin/supermemory-server</string></array>
    <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
    <key>WorkingDirectory</key><string>$HOME</string>
    <key>StandardOutPath</key><string>$HOME/.supermemory/launchd.out.log</string>
    <key>StandardErrorPath</key><string>$HOME/.supermemory/launchd.err.log</string>
</dict></plist>
EOF
            fi
            launchctl bootstrap "gui/$(id -u)" "$agent" 2>/dev/null || launchctl kickstart -k "gui/$(id -u)/com.supermemory.local" 2>/dev/null || true
            ok "launchd agent com.supermemory.local (auto-start at login)"
        elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
            local unit="$HOME/.config/systemd/user/supermemory.service"
            mkdir -p "$(dirname "$unit")"
            printf '[Unit]\nDescription=Supermemory local server\n[Service]\nExecStart=%s\nWorkingDirectory=%s\nRestart=always\n[Install]\nWantedBy=default.target\n' \
                "$HOME/.local/bin/supermemory-server" "$HOME" > "$unit"
            systemctl --user daemon-reload && systemctl --user enable --now supermemory.service >/dev/null 2>&1 \
                && ok "systemd --user unit supermemory.service (auto-start at login)" || warn "systemd unit failed — systemctl --user status supermemory"
        else
            mkdir -p "$HOME/.supermemory"
            # data dir is ./.supermemory relative to the CWD — always launch from $HOME
            ( cd "$HOME" && nohup "$HOME/.local/bin/supermemory-server" >"$HOME/.supermemory/server.log" 2>&1 & )
            ok "supermemory-server started in background (no systemd user session — re-run the installer after reboot)"
        fi
        up=0; for _ in $(seq 1 60); do   # first boot: port answers a moment before the api key is persisted
            curl -s -o /dev/null --max-time 2 http://localhost:6767/ && up=1 && [ -s "$HOME/.supermemory/api-key" ] && break; sleep 1; done
        if [ "$up" = 0 ]; then
            warn "supermemory-server did not start — it requires an LLM key. Fix (either):"
            warn "   export ANTHROPIC_API_KEY=… (or OPENAI_/GEMINI_) and re-run this installer"
            warn "   or run  supermemory-server  once in a terminal and paste a key when asked"
            return 0
        fi
    fi
    [ -s "$HOME/.supermemory/api-key" ] && ok "api key at ~/.supermemory/api-key" \
        || warn "no api key yet — run supermemory-server once in a terminal (first boot mints it), then re-run"
    # provider key: plain env file, or the encrypted env.enc the official installer writes
    { [ -s "$HOME/.supermemory/env" ] || [ -s "$HOME/.supermemory/env.enc" ]; } \
        || warn "no LLM provider for Supermemory — memory EXTRACTION needs OPENAI_/ANTHROPIC_/GEMINI_API_KEY in ~/.supermemory/env; search works without it"
}

write_marked_block() {  # write_marked_block <file> <marker> <content-file>
    local f="$1" mk="$2" body="$3" tmp
    mkdir -p "$(dirname "$f")"; touch "$f"; tmp="$(mktemp)"
    awk -v s="<!-- $mk:start -->" -v e="<!-- $mk:end -->" '$0==s{skip=1} !skip{print} $0==e{skip=0}' "$f" > "$tmp"
    { printf '<!-- %s:start -->\n' "$mk"; cat "$body"; printf '<!-- %s:end -->\n' "$mk"; } >> "$tmp"
    mv "$tmp" "$f"
}

# Living updates: the session-start event runs `mkt-update --hook` (returns instantly, works in
# the background). Claude Code: SessionStart in ~/.claude/settings.json, merged, existing hooks kept.
wire_claude_update_hook() {  # $1 = claude dir
    local f="$1/settings.json"; mkdir -p "$1"
    python3 - "$f" "$MKT_BIN/mkt-update --hook" <<'PY'
import json, os, sys
p, cmd = sys.argv[1:3]
s = json.load(open(p)) if os.path.exists(p) else {}
ss = s.setdefault("hooks", {}).setdefault("SessionStart", [])
if not any("mkt-update" in h.get("command", "") for g in ss for h in g.get("hooks", [])):
    ss.append({"hooks": [{"type": "command", "command": cmd, "timeout": 10}]})
    json.dump(s, open(p, "w"), indent=2); open(p, "a").write("\n"); print("added")
else: print("present")
PY
}
# Hermes registers a shell hook only once it is on the consent allowlist, and it asks for that
# consent on a TTY only — desktop, gateway and cron sessions never ask, so an unapproved hook is
# silently skipped (no auto-update). Installing the kit IS the consent for the kit's own hook:
# record exactly this command via Hermes' own allowlist API. Undo: `hermes hooks revoke <command>`.
approve_hermes_hook() {  # approve_hermes_hook <event> <command>
    local py="$HOME/.hermes/hermes-agent/venv/bin/python"
    [ -x "$py" ] || py="$HOME/.hermes/hermes-agent/.venv/bin/python"
    [ -x "$py" ] || return 1
    (cd "$HOME/.hermes/hermes-agent" && "$py" - "$1" "$2" >/dev/null 2>&1 <<'PY'
import sys
from agent.shell_hooks import _is_allowlisted, _record_approval
event, command = sys.argv[1], sys.argv[2]
if not _is_allowlisted(event, command):
    _record_approval(event, command)
PY
    )
}

wire_hermes_update_hook() {   # appends to hooks.on_session_start (dotted path: other hook sections untouched)
    local cur merged
    approve_hermes_hook on_session_start "$MKT_BIN/mkt-update --hook" || echo "  ⚠ could not record Hermes hook consent — approve it once in a terminal Hermes session" >&2
    cur="$(hermes config get --json hooks.on_session_start 2>/dev/null || echo null)"
    case "$cur" in *mkt-update*) echo present; return ;; esac
    merged="$(python3 -c '
import json, sys
try: cur = json.loads(sys.argv[1]) or []
except Exception: cur = []
if not isinstance(cur, list): cur = []
cur.append({"command": sys.argv[2] + " --hook", "timeout": 10})
print(json.dumps(cur))' "$cur" "$MKT_BIN/mkt-update")"
    hermes config set hooks.on_session_start "$merged" >/dev/null 2>&1 && echo added || echo failed
}

write_kit_version() {  # $1 = kit root  $2 = dir
    mkdir -p "$2"
    printf 'revision: %s\ninstalled: %s\nsource: %s\n' \
        "$(git -C "$1" rev-parse --short HEAD 2>/dev/null || echo unknown)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        "$(git -C "$1" remote get-url origin 2>/dev/null || echo "$1")" > "$2/.marketing-kit-version"
}
