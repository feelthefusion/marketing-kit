#!/usr/bin/env bash
# =============================================================================
# Marketing Kit — shared installer library (sourced by install.sh / hermes.sh)
#
# LIVE BY DESIGN — nothing third-party is cloned or copied into this repo:
#   * kit skills      → SYMLINKED from this checkout (bootstrap pulls it every run)
#   * 3rd-party skills → Claude Code: plugins from each vendor's own marketplace, updated
#                        every run;  Hermes: hub installs from the vendor repo + `hermes
#                        skills update` every run
#   * MCP servers     → `mkt-mcp <name>` launches `pkg@latest` on every start
# =============================================================================

MKT_BIN="$HOME/.local/bin"
MKT_CONF="$HOME/.config/marketing-kit"
MKT_SECRETS="$MKT_CONF/secrets.env"
KIT_SKILLS="marketing-kit growth-data journey-analytics campaign-harden lifecycle-engine playbook-ledger"

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

link_bins() {  # $1 = kit root
    mkdir -p "$MKT_BIN"
    local b
    for b in mkt-mcp mkt-ledger mkt-preflight mkt-doctor; do
        chmod +x "$1/bin/$b"; ln -sfn "$1/bin/$b" "$MKT_BIN/$b"
    done
    chmod +x "$1/install/init-project.sh"; ln -sfn "$1/install/init-project.sh" "$MKT_BIN/mkt-init"
    ok "mkt-mcp mkt-ledger mkt-preflight mkt-doctor mkt-init → $MKT_BIN"
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

google_creds_present() {
    has_secret GOOGLE_APPLICATION_CREDENTIALS || [ -f "$HOME/.config/gcloud/application_default_credentials.json" ]
}

ensure_runtime() {
    command -v node >/dev/null 2>&1 && ok "node $(node -v)" || warn "node missing — install Node 20+ (npx servers + mkt-preflight need it)"
    if command -v uvx >/dev/null 2>&1; then ok "uv $(uv --version 2>/dev/null | awk '{print $2}')"
    else
        say "  · installing uv (runs postgres-mcp, analytics-mcp, mcp-search-console)"
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
            curl -fsSL https://supermemory.ai/install | bash >/dev/null 2>&1 && ok "supermemory-server installed" \
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
        else
            warn "Linux: start it with  nohup supermemory-server >/dev/null 2>&1 &  (or a systemd --user unit)"
        fi
        sleep 3
    fi
    [ -s "$HOME/.supermemory/api-key" ] && ok "api key at ~/.supermemory/api-key" \
        || warn "no api key yet — run supermemory-server once in a terminal (first boot mints it), then re-run"
    [ -s "$HOME/.supermemory/env" ] || warn "no LLM provider in ~/.supermemory/env — memory EXTRACTION needs OPENAI_API_KEY (+ OPENAI_BASE_URL for OpenRouter); search works without it"
}

write_marked_block() {  # write_marked_block <file> <marker> <content-file>
    local f="$1" mk="$2" body="$3" tmp
    mkdir -p "$(dirname "$f")"; touch "$f"; tmp="$(mktemp)"
    awk -v s="<!-- $mk:start -->" -v e="<!-- $mk:end -->" '$0==s{skip=1} !skip{print} $0==e{skip=0}' "$f" > "$tmp"
    { printf '<!-- %s:start -->\n' "$mk"; cat "$body"; printf '<!-- %s:end -->\n' "$mk"; } >> "$tmp"
    mv "$tmp" "$f"
}

write_kit_version() {  # $1 = kit root  $2 = dir
    mkdir -p "$2"
    printf 'revision: %s\ninstalled: %s\nsource: %s\n' \
        "$(git -C "$1" rev-parse --short HEAD 2>/dev/null || echo unknown)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        "$(git -C "$1" remote get-url origin 2>/dev/null || echo "$1")" > "$2/.marketing-kit-version"
}
