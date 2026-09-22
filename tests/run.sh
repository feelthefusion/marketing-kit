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
expect "utm_campaign ≠ id → RED"                    1 "breaks GA4"                    $PF "$T/bad-utm.json"
mk no-utm.json        'spec["channels"][1]["body"] = "Hi {{first_name | there}} https://acme.com/r"'
expect "link without UTMs → RED"                    1 "missing utm_source"            $PF "$T/no-utm.json"
mk emoji.json         'spec["channels"][1]["body"] = spec["channels"][1]["body"].replace("Acme:", "Acme 🚀 “hey”")'
expect "emoji/smart quotes → UCS-2, 3 segments → RED" 1 "UCS-2 because"                 $PF "$T/emoji.json"
mk long-sms.json      'spec["channels"][1]["body"] = "x"*400 + " https://a.co/?utm_source=t&utm_medium=sms&utm_campaign=winback-10d-inactive"'
expect "SMS over max_segments → RED"                1 "exceeds max_segments"          $PF "$T/long-sms.json"
mk no-key.json        'spec["send"]["idempotency_key"] = "{{campaign.id}}"'
expect "idempotency key without contact_id → RED"   1 "idempotency_key"               $PF "$T/no-key.json"
mk no-holdout.json    'del spec["holdout_pct"]'
expect "missing holdout → RED"                      1 "holdout_pct"                   $PF "$T/no-holdout.json"
mk zero-holdout.json  'spec["holdout_pct"] = 0'
expect "holdout 0 → warning, still GREEN"           0 "correlation only"              $PF "$T/zero-holdout.json"
mk slop.json          'spec["channels"][0]["subject"] = "Unlock your seamless journey"'
expect "slop phrases → warning"                     0 "slop phrase \"unlock\""        $PF "$T/slop.json"
expect "--strict turns warnings RED"                1 "GREEN — [1-9]"                 $PF "$T/slop.json" --strict
mk placeholder.json   'spec["channels"][0]["body_text"] += " [FIRST NAME] TODO"'
expect "leftover placeholder → RED"                 1 "leftover placeholder"          $PF "$T/placeholder.json"
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

echo "▶ mkt-init (in a scratch repo with a Starter-Kit style verify.sh)"
cat > "$R/package.json" <<'J'
{"name":"demo","dependencies":{"drizzle-orm":"^0.44.0","resend":"^6.0.0","stripe":"^18.0.0"}}
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

echo "── $pass passed · $fail failed"
[ "$fail" = 0 ]
