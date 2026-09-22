#!/usr/bin/env bash
# Marketing Kit — self-test.  bash tests/run.sh      (no network needed except the optional drizzle typecheck)
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PF="node $KIT/bin/mkt-preflight"
T="$(mktemp -d "${TMPDIR:-/tmp}/mkt-test.XXXXXX")"; trap 'rm -rf "$T"' EXIT
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
expect "default: gsc off, umami core"                0 "gsc +off"                      S bash "$KIT/bin/mkt-settings"
expect "mkt-mcp gsc refuses while off"               1 "Search Console is OFF"         S bash "$KIT/bin/mkt-mcp" gsc
expect "gsc on → switch written"                     0 "gsc → on"                      S bash "$KIT/bin/mkt-settings" gsc on
grep -qx "MKT_GSC=on" "$H/.config/marketing-kit/settings.env" && ok "settings.env has MKT_GSC=on" || bad "settings.env not updated"
expect "gsc on without creds → needs GOOGLE_… (not started)" 1 "GOOGLE_APPLICATION_CREDENTIALS|GSC_OAUTH" S bash "$KIT/bin/mkt-mcp" gsc
expect "bad value refused"                           1 "usage: mkt-settings gsc on"    S bash "$KIT/bin/mkt-settings" gsc maybe
expect "gsc off → back off"                          0 "gsc → off"                     S bash "$KIT/bin/mkt-settings" gsc off
[ "$(grep -c '^MKT_GSC=' "$H/.config/marketing-kit/settings.env")" = 1 ] && ok "toggling never duplicates the key" || bad "duplicate MKT_GSC lines"
expect "umami is not a switch"                       1 "unknown 'umami'"               S bash "$KIT/bin/mkt-settings" umami on

echo "▶ mkt-umami"
expect "mkt-mcp umami without URL → clear error"     1 "mkt-umami deploy"              S bash "$KIT/bin/mkt-mcp" umami
expect "snippet carries the website id + identify"   0 "data-website-id=\"w-123\""     S bash "$KIT/bin/mkt-umami" snippet w-123
expect "snippet links Umami to the CRM contact"      0 "identify\(contact.id"          S bash "$KIT/bin/mkt-umami" snippet w-123
expect "deploy outside a railway-linked repo refuses" 1 "railway CLI missing|not linked" bash -c "cd '$T' && HOME='$H' bash '$KIT/bin/mkt-umami' deploy --dry-run"

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
        f="$(psql -X -At -f <(sed -n '/-- 3. Funnel/,/^$/p' "$KIT/skills/journey-analytics/references/analytics.sql") "$DB" 2>/dev/null)"
        [ "$f" = "250|100|79|36" ] && ok "funnel numbers correct on the fixture (250→100→79→36)" || bad "funnel = '$f' (want 250|100|79|36)"
        echo "▶ outbox worker vs provider limits (real Postgres + mock Resend/Telnyx)"
        W="$T/worker"; WDB="${DB}_w"; mkdir -p "$W/ref"
        cp "$KIT/skills/lifecycle-engine/references/outbox-worker.ts" "$W/ref/"
        printf 'import { drizzle } from "drizzle-orm/node-postgres";\nexport const db = drizzle(process.env.DATABASE_URL!);\n' > "$W/db.ts"
        cp "$KIT/tests/fixtures/worker-e2e.ts" "$W/"
        if (cd "$D" && npm i -s resend@latest telnyx@latest pg @types/node typescript@latest tsx >/dev/null 2>&1) \
           && createdb "$WDB" && sed 's/--> statement-breakpoint//' "$D"/out/*.sql | psql -X -q "$WDB" >/dev/null 2>&1 \
           && psql -X -q -v ON_ERROR_STOP=1 -f "$KIT/tests/fixtures/worker-seed.sql" "$WDB" >/dev/null; then
            ln -s "$D/node_modules" "$W/node_modules"
            (cd "$W" && npx tsc --noEmit --strict --skipLibCheck --types node --module nodenext --moduleResolution nodenext \
                --target es2022 --esModuleInterop ref/outbox-worker.ts) >"$T/wtsc.log" 2>&1 \
                && ok "worker typechecks (strict) against latest resend + telnyx SDKs" || { bad "worker typecheck"; head -10 "$T/wtsc.log"; }
            (cd "$W" && DATABASE_URL="postgres:///$WDB" WORKER="./ref/outbox-worker.ts" MOCK_PORT=4999 RESEND_API_KEY=re_test \
                RESEND_BASE_URL=http://localhost:4999 TELNYX_API_KEY=KEYtest TELNYX_BASE_URL=http://localhost:4999/v2 PUBLIC_URL=https://x \
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
        else bad "worker harness setup"; fi
        dropdb --if-exists "$WDB" >/dev/null 2>&1
    else bad "schema generate/apply"; tail -5 "$T/dk.log" "$T/ddl.log" 2>/dev/null; fi
    dropdb --if-exists "$DB" >/dev/null 2>&1
else echo "  · local Postgres not available — SQL run skipped"; fi

echo "── $pass passed · $fail failed"
[ "$fail" = 0 ]
