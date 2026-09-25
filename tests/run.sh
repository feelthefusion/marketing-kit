#!/usr/bin/env bash
# Marketing Kit — self-test.  bash tests/run.sh      (no network needed except the optional drizzle typecheck)
set -uo pipefail
export USER="${USER:-$(id -un)}"   # node-postgres defaults the DB user to $USER (unset in bare containers)
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PF="node $KIT/bin/mkt-preflight"
T="$(mktemp -d "${TMPDIR:-/tmp}/mkt-test.XXXXXX")"; [ -n "${MKT_TEST_KEEP:-}" ] && echo "kept: $T" || trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { echo "  ✓ $1"; pass=$((pass+1)); }
bad() { echo "  ✗ $1"; fail=$((fail+1)); }
expect() {  # expect <desc> <exit-code> <grep-pattern|-> <cmd...>
    local d="$1" want="$2" pat="$3"; shift 3
    out="$("$@" 2>&1)"; code=$?
    if [ "$code" != "$want" ]; then bad "$d (exit $code, want $want)"; echo "$out" | sed 's/^/      /' | head -12; return; fi
    if [ "$pat" != - ] && ! grep -qE -- "$pat" <<<"$out"; then bad "$d (missing /$pat/)"; echo "$out" | sed 's/^/      /' | head -12; return; fi
    ok "$d"
}
mk() { python3 - "$T/$1" "$2" <<'PY'
import json, sys
base = json.load(open(sys.argv[2].split("::")[0])) if "::" in sys.argv[2] else {}
spec = json.load(open("KIT/templates/campaign.example.json".replace("KIT", __import__("os").environ["KIT"])))
exec(sys.argv[2].split("::")[-1])   # mutate `spec`
json.dump(spec, open(sys.argv[1], "w"))
PY
}
export KIT MKT_NO_PLUGINS=1   # plugin enabling is exercised by the live install, not the unit run
cp "$KIT/templates/winback-10d-inactive.sql" "$T/"

# bash 3.2 in a UTF-8 locale treats high bytes as name chars: a $var glued to a non-ASCII char is an unbound variable under set -u
utf_lint() {  # a function, not $(…): bash 3.2 misparses case patterns inside command substitution
    local f
    git ls-files | while read -r f; do
        case "$f" in *.sh) ;; *) head -1 "$f" 2>/dev/null | grep -q bash || continue ;; esac
        perl -ne 'print "$ARGV:$. " if /(?<!\\)\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/' "$f"
    done
}
utf="$(cd "$(dirname "$0")/.." && utf_lint)"
[ -z "$utf" ] && ok "no \$var glued to a non-ASCII char (bash 3.2 + UTF-8 locale crash)" || bad "\$var followed by non-ASCII — write \${var}: $utf"
echo "▶ mkt-preflight"
cp "$KIT/templates/campaign.example.json" "$T/good.campaign.json"
expect "example campaign is GREEN"                  0 "GREEN"                         $PF "$T/good.campaign.json"
mk unknown-var.json   'spec["channels"][1]["body"] += " {{coupon_code}}"'
expect "unknown template var → RED"                 1 "coupon_code.*not an audience column" $PF "$T/unknown-var.json"
mk bad-utm.json       'spec["channels"][0]["body_text"] = spec["channels"][0]["body_text"].replace("utm_campaign=winback-10d-inactive","utm_campaign=spring")'
expect "utm_campaign ≠ id → warning, still GREEN"   0 "attribution will file it"        $PF "$T/bad-utm.json"
mk no-utm.json        'spec["channels"][1]["body"] = "Hi {{first_name | there}} https://acme.com/r"'
expect "link without UTMs → note only, GREEN"      0 "won.t be attributed"             $PF "$T/no-utm.json"
mk emoji.json         'spec["channels"][1]["body"] = spec["channels"][1]["body"].replace("Acme:", "Acme 🚀 “hey”")'
expect "emoji/smart quotes → UCS-2 warning, GREEN"  0 "UCS-2 because"                  $PF "$T/emoji.json"
mk long-sms.json      'spec["channels"][1]["body"] = "x"*1600 + " https://a.co/?utm_source=t&utm_medium=sms&utm_campaign=winback-10d-inactive"'
expect "SMS over Telnyx 10 segments → RED (40302)"  1 "Telnyx max is 10"               $PF "$T/long-sms.json"
mk mid-sms.json       'spec["channels"][1]["body"] = "x"*400 + " https://a.co/?utm_source=t&utm_medium=sms&utm_campaign=winback-10d-inactive"'
expect "3-segment SMS (no kit cap) → GREEN"          0 "GREEN"                          $PF "$T/mid-sms.json"
mk no-key.json        'spec["send"]["idempotency_key"] = "{{campaign.id}}"'
expect "idempotency key without contact_id → RED"   1 "idempotency_key"               $PF "$T/no-key.json"
mk no-holdout.json    'spec.pop("holdout_pct", None)'
expect "no holdout (optional) → GREEN"            0 "GREEN"                          $PF "$T/no-holdout.json"
mk zero-holdout.json  'spec["holdout_pct"] = 0'
expect "holdout 0 → GREEN"                         0 "GREEN"                          $PF "$T/zero-holdout.json"
mk slop.json          'spec["channels"][0]["subject"] = "Unlock your seamless journey"'
expect "slop phrases → warning"                     0 "slop phrase \"unlock\""        $PF "$T/slop.json"
expect "--strict turns warnings RED"                1 "GREEN — [1-9]"                 $PF "$T/slop.json" --strict
mk placeholder.json   'spec["channels"][0]["body_text"] += " [FIRST NAME] TODO"'
expect "leftover placeholder → RED"                 1 "leftover placeholder"          $PF "$T/placeholder.json"
mk exclude-typo.json  'spec["send"]["exclude"] = ["hardbounce"]'
expect "send.exclude typo → RED"                    1 "unknown reason 'hardbounce'"   $PF "$T/exclude-typo.json"
mk exclude-none.json  'spec["send"]["exclude"] = []'
expect "send.exclude [] (send to everyone) → GREEN"  0 "GREEN"                         $PF "$T/exclude-none.json"
out="$($PF "$T/good.campaign.json" 2>&1)"; grep -qiE "unsubscribe|complian|legal|consent" <<<"$out" && bad "preflight still emits compliance/unsubscribe messages" || ok "preflight has no compliance/unsubscribe checks"
mk rcpt.json          'spec["channels"][0]["to"] = ["a%d@x.co" % i for i in range(51)]'
expect "51 recipients → RED (Resend max 50)"          1 "Resend max is 50"               $PF "$T/rcpt.json"
mk mms.json           'spec["channels"][1]["media_urls"] = ["https://a.co/%d.jpg" % i for i in range(11)]'
expect "11 MMS media → RED (Telnyx 40317)"            1 "Telnyx MMS max is 10"           $PF "$T/mms.json"
mk longkey.json       'spec["send"]["idempotency_key"] = "{{contact_id}}/" + "k"*250'
expect "idempotency key > 256 → RED (Resend)"         1 "256-char limit"                 $PF "$T/longkey.json"
mk nometric.json      'spec.pop("primary_metric", None); spec.pop("hypothesis", None)'
expect "no metric/hypothesis (optional) → GREEN"      0 "GREEN"                          $PF "$T/nometric.json"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["resend"]["requests_per_second_per_team"]==10 and d["resend"]["batch_max_emails"]==100 and d["telnyx"]["sms_max_segments"]==10 and d["telnyx"]["account_mps"]["sms"]==50' "$KIT/templates/provider-limits.json" \
  && ok "provider-limits.json present + core values" || bad "provider-limits.json missing/changed"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["expo_push"]["messages_per_request_max"]==100 and d["expo_push"]["payload_max_bytes"]==4096 and d["web_push"]["guaranteed_body_bytes"]==4096 and d["whatsapp"]["mps_per_number_default"]==80 and d["whatsapp"]["messaging_limit_unique_users_24h"]["new_portfolio"]==250' "$KIT/templates/provider-limits.json" \
  && ok "provider-limits.json: Expo / Web Push / WhatsApp limits (sourced)" || bad "mobile provider limits missing"

echo "▶ one marketing brain (router ↔ installed skills)"
python3 "$KIT/tests/brain_check.py" "$KIT" >"$T/brain.log" 2>&1; n_ok=$(grep -c '^OK' "$T/brain.log")
grep -q '^FAIL' "$T/brain.log" && { bad "brain consistency"; grep '^FAIL' "$T/brain.log"; } \
  || ok "brain: $n_ok checks — every mapped skill installed, no duplicate names, competitors retired, every kit skill owned"
if grep -rqiE "quiet.hours|send.window|frequency.cap|fatigue" "$KIT/templates/campaign.example.json" "$KIT/bin/mkt-preflight"; then bad "kit-imposed send restrictions still present"; else ok "no send windows / frequency caps in spec or gate"; fi
mk write-sql.json     'spec["audience"]["sql"] = "delete from crm_contacts"'
expect "non-SELECT audience → RED"                  1 "read-only SELECT"              $PF "$T/write-sql.json"
echo '{not json' > "$T/broken.campaign.json"
expect "invalid JSON → RED"                         1 "not valid JSON"                $PF "$T/broken.campaign.json"
expect "--json output parses"                       0 '"errors"'                      $PF "$T/good.campaign.json" --json

echo "▶ mkt-mcp db resolution (never prints credentials)"
R="$T/repo"; mkdir -p "$R/.agents"; git -C "$R" init -q
printf 'DATABASE_URL=postgres://u:secretpw@db.internal.railway.internal:5432/x\nDATABASE_PUBLIC_URL="postgres://u:secretpw@abc.proxy.rlwy.net:1234/railway"\n' > "$R/.env"
out="$(cd "$R" && env -u CRM_DATABASE_URL PATH="/usr/bin:/bin:$(dirname "$(command -v node)")" MKT_SECRETS=/dev/null "$KIT/bin/mkt-mcp" db-resolve "$R" 2>&1)"
grep -q "abc.proxy.rlwy.net" <<<"$out" && ok "skips *.railway.internal, picks DATABASE_PUBLIC_URL" || bad "db-resolve picked wrong URL: $out"
grep -q secretpw <<<"$out" && bad "db-resolve leaked the password" || ok "db-resolve output has no password"
printf 'CRM_DATABASE_URL=postgres://ro:pw@replica.example.com/crm\n' > "$R/.agents/marketing-kit.env"
out="$(env -u CRM_DATABASE_URL MKT_SECRETS=/dev/null "$KIT/bin/mkt-mcp" db-resolve "$R" 2>&1)"
grep -q "replica.example.com" <<<"$out" && ok ".agents/marketing-kit.env wins over .env" || bad "precedence wrong: $out"
out="$(env -u CRM_DATABASE_URL MKT_SECRETS=/dev/null MKT_DB_ACCESS=yolo "$KIT/bin/mkt-mcp" db "$R" 2>&1)"; code=$?
[ $code = 1 ] && grep -q "restricted|unrestricted" <<<"$out" && ok "invalid MKT_DB_ACCESS refused" || bad "MKT_DB_ACCESS not validated ($code: $out)"
out="$(env -u TELNYX_API_KEY MKT_SECRETS=/dev/null "$KIT/bin/mkt-mcp" telnyx 2>&1)"; code=$?
[ $code = 1 ] && grep -q "TELNYX_API_KEY is not set" <<<"$out" && ok "missing secret → clear error" || bad "missing secret handling ($code: $out)"

echo "▶ mkt-settings (isolated HOME — never touches real Claude/Hermes config)"
H="$T/home"; mkdir -p "$H"
S() { env HOME="$H" PATH="/usr/bin:/bin:$(dirname "$(command -v node)")" MKT_SETTINGS= MKT_SECRETS= "$@"; }
expect "default: gsc off"                            0 "gsc +off"                      S bash "$KIT/bin/mkt-settings"
expect "mkt-mcp gsc refuses while off"               1 "Search Console is OFF"         S bash "$KIT/bin/mkt-mcp" gsc
expect "gsc on → switch written"                     0 "gsc → on"                      S bash "$KIT/bin/mkt-settings" gsc on
grep -qx "MKT_GSC=on" "$H/.config/marketing-kit/settings.env" && ok "settings.env has MKT_GSC=on" || bad "settings.env not updated"
expect "gsc on without creds → needs GOOGLE_… (not started)" 1 "GOOGLE_APPLICATION_CREDENTIALS|GSC_OAUTH" S bash "$KIT/bin/mkt-mcp" gsc
expect "bad value refused"                           1 "usage: mkt-settings gsc on"    S bash "$KIT/bin/mkt-settings" gsc maybe
expect "gsc off → back off"                          0 "gsc → off"                     S bash "$KIT/bin/mkt-settings" gsc off
[ "$(grep -c '^MKT_GSC=' "$H/.config/marketing-kit/settings.env")" = 1 ] && ok "toggling never duplicates the key" || bad "duplicate MKT_GSC lines"
expect "umami is not a feature (retired)"            1 "unknown 'umami'"               S bash "$KIT/bin/mkt-settings" umami on

echo "▶ Umami retired (crm_events is the only analytics store)"
expect "mkt-mcp umami → unknown server"              1 "unknown server 'umami'"        S bash "$KIT/bin/mkt-mcp" umami
left="$(cd "$KIT" && grep -rli umami --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.cache . | grep -vxE './(tests/run.sh|install/install.sh|install/hermes.sh|install/lib.sh|bin/mkt-doctor)' | tr '\n' ' ')"
[ -z "$left" ] && ok "no Umami left outside the retirement cleanup (installers unregister it, lib drops the link, doctor flags old keys)" || bad "Umami still referenced in: $left"
[ ! -e "$KIT/bin/mkt-umami" ] && ok "mkt-umami CLI removed" || bad "bin/mkt-umami still shipped"

echo "▶ mkt-init (in a scratch repo with a Starter-Kit style verify.sh)"
cat > "$R/package.json" <<'J'
{"name":"demo","dependencies":{"drizzle-orm":"^0.44.0","resend":"^6.0.0"}}
J
mkdir -p "$R/shared"; echo 'export const users = pgTable("users", {}); export const orders = pgTable("orders", {});' > "$R/shared/schema.ts"
printf '#!/usr/bin/env bash\nset -euo pipefail\nstep() { echo "── $1"; }\nstep "test"\ntrue\n\nprintf %s\n' "'\\n✓ verify passed — every check green\\n'" > "$R/verify.sh"; chmod +x "$R/verify.sh"
echo "# Demo rules" > "$R/CLAUDE.md"
(cd "$R" && PATH="$KIT/bin:$PATH" bash "$KIT/install/init-project.sh" >"$T/init.log" 2>&1) && ok "mkt-init exits 0" || { bad "mkt-init failed"; cat "$T/init.log"; }
grep -q "users" "$R/.agents/growth-stack.md" && grep -q "Resend (\^6" "$R/.agents/growth-stack.md" && ok "growth-stack.md drafted from repo (tables + deps)" || bad "growth-stack.md draft incomplete"
grep -q "marketing-kit:start" "$R/CLAUDE.md" && [ ! -f "$R/AGENTS.md" ] && ok "block added to the real CLAUDE.md, no rival AGENTS.md" || bad "instructions block placement"
grep -qxF ".agents/marketing-kit.env" "$R/.gitignore" && ok ".gitignore protects marketing-kit.env" || bad ".gitignore"
awk '/campaign preflight/{a=NR} /verify passed/{b=NR} END{exit !(a && b && a<b)}' "$R/verify.sh" && ok "verify.sh step inserted before the final success line" || bad "verify.sh insertion"
grep -q "mkt-preflight example GREEN" "$T/init.log" && ok "example campaign GREEN inside the new repo" || bad "example not GREEN in repo"
cp "$R/CLAUDE.md" "$T/c1"; cp "$R/verify.sh" "$T/v1"
(cd "$R" && PATH="$KIT/bin:$PATH" bash "$KIT/install/init-project.sh" >/dev/null 2>&1)
cmp -s "$R/CLAUDE.md" "$T/c1" && cmp -s "$R/verify.sh" "$T/v1" && ok "re-run is idempotent (no duplicate blocks)" || bad "re-run changed files"
cp "$T/unknown-var.json" "$R/campaigns/bad.campaign.json"
(cd "$R" && PATH="$KIT/bin:$PATH" ./verify.sh >/dev/null 2>&1); [ $? != 0 ] && ok "verify.sh goes RED on a broken campaign" || bad "verify.sh did not block the broken campaign"
rm "$R/campaigns/bad.campaign.json"
(cd "$R" && PATH="$KIT/bin:$PATH" ./verify.sh >/dev/null 2>&1) && ok "verify.sh GREEN again after the fix" || bad "verify.sh still red"

echo "▶ mkt-ledger (live local Supermemory, skipped if not running)"
if "$KIT/bin/mkt-ledger" doctor >/dev/null 2>&1; then
    MKT_LEDGER_CONTAINER=mkt-selftest MKT_PROJECT=selftest "$KIT/bin/mkt-ledger" save lift "selftest-campaign: +4.2pt vs 10% holdout n=300" | grep -q saved && ok "ledger save" || bad "ledger save"
    got=""; for i in 1 2 3 4 5 6; do sleep 5; got="$(MKT_LEDGER_CONTAINER=mkt-selftest "$KIT/bin/mkt-ledger" recall "selftest-campaign holdout" 3)"; grep -q selftest <<<"$got" && break; done
    grep -q "lift|selftest" <<<"$got" && ok "ledger recall returns it with kind + project" || bad "ledger recall: $got"
else echo "  · ledger not reachable — skipped"; fi

if [ "${MKT_TEST_TYPECHECK:-1}" = 1 ] && command -v npm >/dev/null; then
    echo "▶ reference schema typechecks against latest drizzle-orm"
    S="$T/schema"; mkdir -p "$S"; cp "$KIT/skills/growth-data/references/crm-schema.ts" "$S/"
    (cd "$S" && npm init -y >/dev/null && npm i -s drizzle-orm@latest typescript@latest >/dev/null 2>&1 \
        && npx tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext --skipLibCheck crm-schema.ts >"$T/tsc.log" 2>&1) \
        && ok "crm-schema.ts compiles (drizzle-orm $(cd "$S" && node -p 'JSON.parse(require("fs").readFileSync("node_modules/drizzle-orm/package.json")).version'))" || { bad "crm-schema.ts typecheck"; head -20 "$T/tsc.log"; }
fi

if [ "${MKT_TEST_SQL:-1}" = 1 ] && command -v createdb >/dev/null && command -v psql >/dev/null && psql -Atc "select 1" postgres >/dev/null 2>&1 && command -v npm >/dev/null; then
    echo "▶ analytics + cohort SQL run on real Postgres (schema generated by drizzle-kit from crm-schema.ts)"
    D="$T/sql"; DB="mkt_selftest_$$"; mkdir -p "$D"; cp "$KIT/skills/growth-data/references/crm-schema.ts" "$D/schema.ts"
    printf 'import { defineConfig } from "drizzle-kit";\nexport default defineConfig({ dialect: "postgresql", schema: "./schema.ts", out: "./out" });\n' > "$D/drizzle.config.ts"
    if (cd "$D" && npm init -y >/dev/null && npm i -s drizzle-orm@latest drizzle-kit@latest >/dev/null 2>&1 && npx drizzle-kit generate >"$T/dk.log" 2>&1) \
       && createdb "$DB" && sed 's/--> statement-breakpoint//' "$D"/out/*.sql | psql -X -q -v ON_ERROR_STOP=1 "$DB" >/dev/null 2>"$T/ddl.log"; then
        ok "drizzle-kit DDL applies cleanly"
        psql -X -q -v ON_ERROR_STOP=1 -f "$KIT/tests/fixtures/seed.sql" "$DB" >/dev/null 2>"$T/seed.log" && ok "seeded synthetic journey" || { bad "seed"; head -5 "$T/seed.log"; }
        python3 "$KIT/tests/sql_check.py" "$DB" "$KIT" >"$T/sql.log" 2>&1 && ok "all $(grep -c '^OK' "$T/sql.log") report/cohort queries run" || { bad "SQL queries"; grep ERR "$T/sql.log"; }
        psql -X -q -v ON_ERROR_STOP=1 -f "$KIT/tests/fixtures/mobile-seed.sql" "$DB" >/dev/null 2>"$T/mseed.log" && ok "seeded devices, vitals, installs" || { bad "mobile seed"; head -5 "$T/mseed.log"; }
        v="$(psql -X -At -f <(sed -n '/-- 3. Core Web Vitals/,/^$/p' "$KIT/skills/mobile-growth/references/mobile.sql") "$DB" 2>&1 | tr '\n' ' ')"
        grep -q "mobile|LCP|2800|4|50.0" <<<"$v" && grep -q "desktop|LCP|1050|2|100.0" <<<"$v" \
          && ok "Core Web Vitals p75 per device correct (mobile LCP 2800 ms, desktop 1050 ms)" || bad "vitals p75 = $v"
        dm="$(psql -X -At -f <(sed -n '/-- 1. Device mix/,/^$/p' "$KIT/skills/mobile-growth/references/mobile.sql") "$DB" 2>&1 | cut -d'|' -f1,2 | sort | tr '\n' ' ')"
        [ "$(psql -X -At -c "select count(distinct session_id) from crm_events where name='page.viewed' and occurred_at > now() - interval '28 days'" "$DB")" = "$(awk -F'|' '{s+=$2} END {print s}' <<<"$(tr ' ' '\n' <<<"$dm")")" ] \
          && ok "device mix covers every session ($dm)" || bad "device mix = $dm"
        f="$(psql -X -At -f <(sed -n '/-- 3. Funnel/,/^$/p' "$KIT/skills/journey-analytics/references/analytics.sql") "$DB" 2>/dev/null)"
        [ "$f" = "250|100|79|36" ] && ok "funnel numbers correct on the fixture (250→100→79→36)" || bad "funnel = '$f' (want 250|100|79|36)"
        echo "▶ outbox worker vs provider limits (real Postgres + mock Resend/Telnyx)"
        W="$T/worker"; WDB="${DB}_w"; mkdir -p "$W/ref"
        cp "$KIT/skills/lifecycle-engine/references/outbox-worker.ts" "$W/ref/"
        printf 'import { drizzle } from "drizzle-orm/node-postgres";\nexport const db = drizzle(process.env.DATABASE_URL!);\n' > "$W/db.ts"
        cp "$KIT/tests/fixtures/worker-e2e.ts" "$W/"
        if (cd "$D" && npm i -s zod@latest resend@latest telnyx@latest expo-server-sdk@latest web-push@latest @types/web-push qrcode@latest @types/qrcode jsqr pngjs @types/pngjs pg @types/pg @types/node typescript@latest tsx >/dev/null 2>&1) \
           && createdb "$WDB" && sed 's/--> statement-breakpoint//' "$D"/out/*.sql | psql -X -q "$WDB" >/dev/null 2>&1 \
           && psql -X -q -v ON_ERROR_STOP=1 -f "$KIT/tests/fixtures/worker-seed.sql" "$WDB" >/dev/null; then
            ln -s "$D/node_modules" "$W/node_modules"
            (cd "$W" && npx tsc --noEmit --strict --skipLibCheck --types node --module nodenext --moduleResolution nodenext \
                --target es2022 --esModuleInterop ref/outbox-worker.ts) >"$T/wtsc.log" 2>&1 \
                && ok "worker typechecks (strict) against latest resend + telnyx + expo-server-sdk + web-push" || { bad "worker typecheck"; head -10 "$T/wtsc.log"; }
            (cd "$W" && DATABASE_URL="postgres:///$WDB" WORKER="./ref/outbox-worker.ts" MOCK_PORT=4999 RESEND_API_KEY=re_test \
                RESEND_BASE_URL=http://localhost:4999 TELNYX_API_KEY=KEYtest TELNYX_BASE_URL=http://localhost:4999/v2 PUBLIC_URL=https://x \
                EXPO_BASE_URL=http://localhost:4999 \
                npx tsx worker-e2e.ts) >"$T/we2e.log" 2>&1
            q() { psql -X -At "$WDB" -c "$1"; }
            [ "$(q "select count(*) from crm_messages where channel='email' and status='sent'")" = 100 ] \
                && ok "email: one Resend batch of 100 (≤100 per request)" || bad "email batch sent = $(q "select count(*) from crm_messages where channel='email' and status='sent'")"
            [ "$(q "select count(*) from crm_messages where status='queued' and error like 'daily_quota_exceeded%' and scheduled_for = (date_trunc('day', now() at time zone 'utc') + interval '1 day') at time zone 'utc'")" = 49 ] \
                && ok "Resend daily quota → held until 00:00 UTC (not failed)" || { bad "daily-quota hold"; tail -5 "$T/we2e.log"; }
            [ "$(q "select count(*) from crm_messages where status='skipped' and error like 'provider refuses: hard_bounce'")" = 1 ] \
                && ok "Resend-suppressed address skipped" || bad "hard_bounce skip"
            [ "$(q "select reason||'|'||source from crm_suppressions where value='+15550000300'")" = "opted_out|telnyx:40300" ] \
                && ok "Telnyx 40300 recorded as provider refusal" || bad "40300 handling"
            [ "$(q "select count(*) from crm_messages where channel='sms' and status='sent'")" = 2 ] && ok "SMS sent, paced per sender" || bad "sms sent"
            n_ok=$(grep -c '^OK' "$T/we2e.log"); n_bad=$(grep -c '^FAIL' "$T/we2e.log")
            [ "$n_ok" -ge 8 ] && [ "$n_bad" = 0 ] && ok "push (Expo + Web Push), WhatsApp, in-app: $n_ok checks (receipts, dead tokens revoked, 40008)" \
              || { bad "mobile channels ($n_ok ok, $n_bad fail)"; grep -vE '^OK' "$T/we2e.log" | head -12; }
        else bad "worker harness setup"; fi
        dropdb --if-exists "$WDB" >/dev/null 2>&1

        echo "▶ first-party collector (real Postgres, the kit's schema — crm_events is the only analytics store)"
        C="$T/collector"; CDB="${DB}_c"; mkdir -p "$C/ref"
        cp "$KIT/skills/journey-analytics/references/first-party-tracking.ts" "$C/ref/"
        cp "$KIT/tests/fixtures/collector-e2e.mts" "$C/"
        ln -sfn "$D/node_modules" "$C/node_modules"
        if (cd "$C" && "$D/node_modules/.bin/tsc" --noEmit --strict --skipLibCheck --target es2022 --module nodenext --moduleResolution nodenext --lib es2022,dom --types node ref/first-party-tracking.ts >"$T/ctsc.log" 2>&1); then
            ok "first-party-tracking.ts typechecks (strict, zod + drizzle @latest, DOM + server halves)"
        else bad "first-party-tracking.ts typecheck"; head -8 "$T/ctsc.log"; fi
        dropdb --if-exists "$CDB" >/dev/null 2>&1; createdb "$CDB"
        if sed 's/--> statement-breakpoint//' "$D"/out/*.sql | psql -X -q -v ON_ERROR_STOP=1 "$CDB" >/dev/null 2>&1; then
            if (cd "$C" && DATABASE_URL="postgres:///$CDB" ANALYTICS_SQL="$KIT/skills/journey-analytics/references/analytics.sql" "$D/node_modules/.bin/tsx" collector-e2e.mts >"$T/collector.log" 2>&1); then
                ok "collector E2E: $(grep -c '^OK' "$T/collector.log") checks (retry dedupe · server-derived device/place · forged order.paid refused · §D bounce/duration)"
            else bad "collector E2E"; grep -E '^FAIL|Error' "$T/collector.log" | head -8; fi
        else bad "collector DB schema"; fi
        dropdb --if-exists "$CDB" >/dev/null 2>&1

        echo "▶ partner-program + loyalty-engine (real Postgres + mock PayPal)"
        P="$T/prog"; PDB="${DB}_p"; mkdir -p "$P/ref" "$P/sql"
        cp "$KIT"/skills/partner-program/references/{partner-tracking,payouts,creator-discovery}.ts "$KIT"/skills/loyalty-engine/references/loyalty.ts \
           "$KIT"/skills/meta-ads/references/meta-capi.ts "$KIT"/skills/growth-optimizer/references/bandit.ts \
           "$KIT"/skills/mobile-growth/references/app-server.ts "$P/ref/"
        cp "$KIT"/skills/partner-program/references/partner.sql "$KIT"/skills/loyalty-engine/references/loyalty.sql "$P/sql/"
        cp "$KIT"/tests/fixtures/{programs-e2e,bandit-e2e,mobile-e2e}.mts "$P/"
        ln -s "$D/node_modules" "$P/node_modules"
        pq() { psql -X -At "$PDB" -c "$1"; }
        if createdb "$PDB" && sed 's/--> statement-breakpoint//' "$D"/out/*.sql | psql -X -q -v ON_ERROR_STOP=1 "$PDB" >/dev/null 2>&1 \
           && psql -X -q -v ON_ERROR_STOP=1 -f "$KIT/tests/fixtures/programs-seed.sql" "$PDB" >/dev/null 2>"$T/pseed.log"; then
            (cd "$P" && npx tsc --noEmit --strict --skipLibCheck --types node --lib es2022,dom --module nodenext --moduleResolution nodenext \
                --target es2022 ref/*.ts) >"$T/ptsc.log" 2>&1 && ok "7 program + mobile references typecheck (strict)" || { bad "program refs typecheck"; head -10 "$T/ptsc.log"; }
            for i in 1 2; do psql -X -q -v ON_ERROR_STOP=1 -f "$P/sql/partner.sql" "$PDB" >/dev/null 2>"$T/psql.log" || bad "partner.sql run $i"; done
            [ "$(pq "select string_agg(partner_id::text||'='||s, ',' order by partner_id) from (select partner_id, sum(amount_cents) s from crm_commissions where status='approved' and payout_id is null group by 1) x")" \
              = "00000000-0000-0000-0000-0000000000a1=10050,00000000-0000-0000-0000-0000000000a2=1000" ] \
              && ok "commissions: tier at order time, refund clawback, hold → Maya \$100.50, referrer \$10" || bad "partner.sql payable"
            [ "$(pq "select count(*)||'|'||sum(amount_cents) from crm_commissions")" = "5|13250" ] && ok "partner.sql is idempotent (2 runs → 5 rows)" || bad "partner.sql idempotency"
            for i in 1 2; do psql -X -q -v ON_ERROR_STOP=1 -f "$P/sql/loyalty.sql" "$PDB" >/dev/null 2>>"$T/psql.log" || bad "loyalty.sql run $i"; done
            [ "$(pq "select string_agg(c.email||':'||s.tier||':'||s.points, ',' order by c.email) from crm_loyalty_status s join crm_contacts c on c.id=s.contact_id where c.email like 'b%'")" \
              = "b1@x.test:silver:1125,b2@x.test:member:250,b3@x.test:member:280" ] && ok "loyalty: tiers on 12-month spend, multiplier, refund clawback" || bad "loyalty.sql balances"
            (cd "$P" && DATABASE_URL="postgres:///$PDB" MKT_SQL_DIR="$P/sql" npx tsx programs-e2e.mts) >"$T/pe2e.log" 2>&1
            n_ok=$(grep -c '^OK' "$T/pe2e.log"); n_bad=$(grep -c '^FAIL' "$T/pe2e.log")
            [ "$n_ok" -ge 23 ] && [ "$n_bad" = 0 ] && ok "programs E2E: $n_ok checks (attribution, payouts, PayPal/Venmo, webhooks, Cash App, loyalty)" \
              || { bad "programs E2E ($n_ok ok, $n_bad fail)"; grep -v '^OK' "$T/pe2e.log" | head -10; }
            (cd "$P" && DATABASE_URL="postgres:///$PDB" npx tsx bandit-e2e.mts) >"$T/be2e.log" 2>&1
            n_ok=$(grep -c '^OK' "$T/be2e.log"); n_bad=$(grep -c '^FAIL' "$T/be2e.log")
            [ "$n_ok" -ge 6 ] && [ "$n_bad" = 0 ] && ok "bandit: value-weighted Thompson converges, sticky, learns on reward" \
              || { bad "bandit E2E ($n_ok ok, $n_bad fail)"; grep -v '^OK' "$T/be2e.log" | head -10; }
            (cd "$P" && DATABASE_URL="postgres:///$PDB" npx tsx mobile-e2e.mts) >"$T/me2e.log" 2>&1
            n_ok=$(grep -c '^OK' "$T/me2e.log"); n_bad=$(grep -c '^FAIL' "$T/me2e.log")
            [ "$n_ok" -ge 25 ] && [ "$n_bad" = 0 ] && ok "mobile E2E: $n_ok checks (app links, QR → decoded link, install claims → creator credit, Apple Ads, AdAttributionKit, inbox, review moments)" \
              || { bad "mobile E2E ($n_ok ok, $n_bad fail)"; grep -v '^OK' "$T/me2e.log" | head -12; }
        else bad "programs DB setup"; head -5 "$T/pseed.log"; fi
        dropdb --if-exists "$PDB" >/dev/null 2>&1

        if [ "${MKT_TEST_ML:-1}" = 1 ] && command -v uv >/dev/null; then
            echo "▶ growth-optimizer on synthetic history (uv, real Postgres)"
            for size in big tiny; do
                ODB="${DB}_o$size"; createdb "$ODB" && sed 's/--> statement-breakpoint//' "$D"/out/*.sql | psql -X -q "$ODB" >/dev/null 2>&1 \
                  && psql -X -q -f "$KIT/skills/growth-optimizer/references/optimizer.sql" "$ODB" >/dev/null 2>&1
                DATABASE_URL="postgres:///$ODB" uv run -q "$KIT/tests/fixtures/optimizer-synth.py" "$size" >/dev/null 2>&1
                DATABASE_URL="postgres:///$ODB" uv run -q "$KIT/skills/growth-optimizer/scripts/optimize.py" >"$T/opt_$size.json" 2>"$T/opt_$size.err"
                if [ "$size" = big ]; then
                    python3 - "$T/opt_big.json" <<'PY' && ok "big: gbm beats baselines on held-out time (churn AUC, CLV deviance), CLV calibrated" || { bad "optimizer big"; head -40 "$T/opt_big.json" "$T/opt_big.err"; }
import json, sys
c = json.load(open(sys.argv[1]))["customers"]
ch, cl = c["churn_90d"], c["clv"]
assert ch["used"].endswith("gbm") and ch["auc_model"] > ch["auc_baseline"] and ch["auc_model"] > 0.85, ch
assert cl["used"].endswith("gbm") and cl["dev_model"] < cl["dev_baseline"] and 0.7 < cl["calibration_model"] < 1.3, cl
PY
                    [ "$(psql -X -At "$ODB" -c "select string_agg(subject_id, ',' order by value desc) from crm_scores where model='partner_quality'")" \
                      = "00000000-0000-0000-0000-000000000a11,00000000-0000-0000-0000-000000000b22" ] && ok "partner_quality ranks the repeat-buyer creator above the refunder" || bad "partner_quality order"
                    [ "$(psql -X -At "$ODB" -c "select count(distinct subject_id) from crm_scores where model in ('churn_90d','clv')")" = 1200 ] && ok "scores written for all 1,200 customers" || bad "score coverage"
                    OPTIMIZER_DATABASE_URL="postgres:///$ODB" uv run -q "$KIT/skills/growth-optimizer/scripts/optimize.py" --if-due | grep -q '"not due"' \
                      && ok "--if-due: no new orders → no retrain" || bad "--if-due"
                else
                    python3 -c 'import json,sys; c=json.load(open(sys.argv[1]))["customers"]; assert all(v["used"].endswith("baseline") for v in c.values()), c' "$T/opt_tiny.json" \
                      && ok "tiny (94 orders): gated → transparent baselines, no overfit model" || { bad "optimizer tiny"; head -20 "$T/opt_tiny.json" "$T/opt_tiny.err"; }
                fi
                dropdb --if-exists "$ODB" >/dev/null 2>&1
            done
            EDB="${DB}_e"; createdb "$EDB"
            OPTIMIZER_DATABASE_URL="postgres:///$EDB" uv run -q "$KIT/skills/growth-optimizer/scripts/optimize.py" --if-due | grep -q "not migrated" \
              && ok "--if-due in a project without program tables: silent no-op" || bad "--if-due unmigrated"
            dropdb --if-exists "$EDB" >/dev/null 2>&1
        else echo "  · growth-optimizer run skipped (MKT_TEST_ML=0 or no uv)"; fi
    else bad "schema generate/apply"; tail -5 "$T/dk.log" "$T/ddl.log" 2>/dev/null; fi
    dropdb --if-exists "$DB" >/dev/null 2>&1
else echo "  · local Postgres not available — SQL run skipped"; fi

echo "▶ living updates: mkt-update (event-driven, offline via local bare repos)"
LU="$T/lu"; mkdir -p "$LU/remotes/test" "$LU/remotes/resend" "$LU/home" "$LU/proj"
CLEANPATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"   # no claude/hermes → updates apply nothing global
cp -R "$KIT" "$LU/kit" && rm -rf "$LU/kit/.git"
( cd "$LU/kit" && git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm kit && git remote add origin https://github.com/test/kit )
for r in test/kit resend/resend-skills; do
    git init -q --bare "$LU/remotes/$r.git" 2>/dev/null; mv "$LU/remotes/$r.git" "$LU/remotes/$r"
    tmpc="$LU/c-$(basename "$r")"; git clone -q "$LU/remotes/$r" "$tmpc" 2>/dev/null
    ( cd "$tmpc" && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m one && git push -q origin HEAD 2>/dev/null )
done
mu() { env -i HOME="$LU/home" PATH="$CLEANPATH" XDG_CONFIG_HOME="$LU/cfg" MKT_GIT_BASE="file://$LU/remotes" MKT_NO_PLUGINS=1 "$@"; }
mu "$LU/kit/bin/mkt-update" >/dev/null 2>&1
n="$(python3 -c "import json;print(len(json.load(open('$LU/cfg/marketing-kit/update-state.json'))['rev']))" 2>/dev/null)"
[ "$n" = 3 ] && ok "first run records upstream revisions (kit + resend marketplace + resend hub skills)" || bad "state records ($n)"
mu "$LU/kit/bin/mkt-update" --check | grep -q "everything current" && ok "no upstream movement → nothing to do" || bad "idle check"
( cd "$LU/c-resend-skills" && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m two && git push -q origin HEAD 2>/dev/null )
out="$(mu "$LU/kit/bin/mkt-update" --check)"
echo "$out" | grep -q "marketplace:resend-skills" && echo "$out" | grep -q "hermes-skills:resend/resend-skills" \
    && ! echo "$out" | grep -q " kit " && ok "upstream push detected — only the moved components flagged" || bad "change detection: $out"
# project sync on session start
( cd "$LU/proj" && git init -q && mkdir -p .agents && echo "# stack" > .agents/growth-stack.md && echo stale > .agents/.marketing-kit-version )
echo "done: x" > "$LU/cfg/marketing-kit/update-notice.txt"
s=$(python3 -c 'import time;print(time.time())')
hout="$(echo "{\"cwd\":\"$LU/proj\",\"hook_event_name\":\"SessionStart\"}" | mu "$LU/kit/bin/mkt-update" --hook)"
ms=$(python3 -c "import time;print(int((time.time()-$s)*1000))")
[ "$ms" -lt 2500 ] && ok "hook returns immediately (${ms} ms) — work happens in background" || bad "hook took ${ms} ms"
echo "$hout" | grep -q "^Marketing Kit auto-updated since your last session: done: x" && ok "Claude Code: previous run's updates → session context" || bad "claude notice: $hout"
for _ in $(seq 1 40); do [ "$(cat "$LU/proj/.agents/.marketing-kit-version")" != stale ] && break; sleep 1; done
[ "$(cat "$LU/proj/.agents/.marketing-kit-version")" = "$(git -C "$LU/kit" rev-parse --short=12 HEAD)" ] \
    && ok "stale project re-synced to the kit in the background" || bad "project sync"
for _ in $(seq 1 10); do [ -d "$LU/cfg/marketing-kit/update.lock" ] || break; sleep 1; done
hj="$(echo "{\"cwd\":\"$LU/proj\",\"hook_event_name\":\"on_session_start\"}" | mu "$LU/kit/bin/mkt-update" --hook)"
python3 -c "import json,sys; d=json.loads(sys.argv[1]); assert 'kit-managed files synced' in d['context']" "$hj" 2>/dev/null \
    && ok "Hermes: sync result delivered as {\"context\": …} next session" || bad "hermes notice: $hj"
echo '' | mu env MKT_UPDATE=off "$LU/kit/bin/mkt-update" --hook | grep -q . && bad "MKT_UPDATE=off still ran" || ok "MKT_UPDATE=off → hook is a no-op"
# hook wiring: idempotent, never clobbers existing hooks
mkdir -p "$LU/cc"; echo '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"mine.sh"}]}],"Stop":[{"hooks":[{"type":"command","command":"stop.sh"}]}]}}' > "$LU/cc/settings.json"
( source "$KIT/install/lib.sh" >/dev/null 2>&1; MKT_BIN=/x; wire_claude_update_hook "$LU/cc"; wire_claude_update_hook "$LU/cc" ) >/dev/null
python3 - "$LU/cc/settings.json" <<'PY' && ok "SessionStart hook wired once; existing hooks kept" || bad "hook wiring"
import json, sys
h = json.load(open(sys.argv[1]))["hooks"]
cmds = [x["command"] for g in h["SessionStart"] for x in g["hooks"]]
assert cmds.count("/x/mkt-update --hook") == 1 and "mine.sh" in cmds and h["Stop"], cmds
PY
# CLI-less sync (CI runner) must not churn .claude/settings.json → no empty PRs
( cd "$LU/proj" && mu bash "$LU/kit/install/init-project.sh" >/dev/null 2>&1; mu env MKT_NO_PLUGINS=0 bash "$LU/kit/install/init-project.sh" >/dev/null 2>&1; cp .claude/settings.json "$LU/s2"; mu env MKT_NO_PLUGINS=0 bash "$LU/kit/install/init-project.sh" >/dev/null 2>&1 )
cmp -s "$LU/s2" "$LU/proj/.claude/settings.json" && grep -q '"resend@resend-skills": true' "$LU/s2" \
    && ok "no-CLI sync writes project plugins once, then leaves settings.json byte-identical" || bad "settings churn"
python3 - "$KIT/.github/workflows/notify-projects.yml" "$KIT/templates/github/marketing-kit-sync.yml" <<'PY' && ok "webhook workflows: dispatch-driven, no schedule, full-SHA pins" || bad "workflow shape"
import re, sys
a, b = (open(p).read() for p in sys.argv[1:3])
assert not re.search(r"^\s*(schedule|- cron):", a + b, re.M)
assert "repository_dispatch" in b and "types: [marketing-kit-updated]" in b and "event_type=marketing-kit-updated" in a
assert all(re.search(r"@[0-9a-f]{40}\b", l) for l in (a + b).splitlines() if "uses:" in l)
PY

echo "── $pass passed · $fail failed"
[ "$fail" = 0 ]
