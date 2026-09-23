#!/usr/bin/env python3
"""Brain consistency: the router's ownership map only names skills that are installed, every
installed name is unique (nothing duplicates), competing owners stay retired, and every kit skill
has a place in the map. Usage: brain_check.py <kit-root>. Prints OK/FAIL lines; exits 1 on FAIL."""
import os, re, sys

kit = sys.argv[1]
fails = 0
def check(name, cond, got=""):
    global fails
    print(("OK   " if cond else "FAIL ") + name + ("" if cond else f" — {got}"))
    fails += 0 if cond else 1

# installed names: kit skills + curated upstream (manifest) + vendor packs (plugins / hub)
lib = open(f"{kit}/install/lib.sh").read()
kit_skills = re.search(r'KIT_SKILLS="([^"]+)"', lib).group(1).split()
rows = [l.rstrip("\n").split("\t") for l in open(f"{kit}/install/upstream-skills.tsv") if l.strip() and not l.startswith("#")]
check("manifest rows have ident/hosts/trust/owns", all(len(r) >= 4 and r[1] in ("both", "claude", "hermes") for r in rows),
      [r for r in rows if len(r) < 4 or r[1] not in ("both", "claude", "hermes")][:3])
upstream = [r[0].rsplit("/", 1)[-1] for r in rows]
vendor = ["resend", "react-email", "email-best-practices", "telnyx-messaging-javascript",
          "telnyx-messaging-profiles-javascript", "telnyx-whatsapp-javascript", "hyperframes", "humanizer"]
hermes_tsv = [l.split("\t")[0].rsplit("/", 1)[-1] for l in open(f"{kit}/install/hermes-skills.tsv") if l.strip() and not l.startswith("#")]
check("every Hermes vendor-pack skill is a known vendor skill", set(hermes_tsv) <= set(vendor), set(hermes_tsv) - set(vendor))
allnames = kit_skills + upstream + vendor
dups = sorted({n for n in allnames if allnames.count(n) > 1})
check(f"{len(allnames)} installed skill names, all unique (nothing duplicates)", not dups, dups)
check("competing owners stay retired (analytics, revops)", not {"analytics", "revops"} & set(upstream))
check("kit skills all exist on disk", all(os.path.isfile(f"{kit}/skills/{s}/SKILL.md") for s in kit_skills),
      [s for s in kit_skills if not os.path.isfile(f"{kit}/skills/{s}/SKILL.md")])
check("marketingskills: every upstream skill except the retired two is listed",
      len([r for r in rows if r[0].startswith("coreyhaines31/marketingskills/")]) >= 48)

# router ownership map
router = open(f"{kit}/skills/marketing-kit/SKILL.md").read()
table = router.split("## Ownership map", 1)[1].split("\n## ", 1)[0]
named = set()
for line in table.splitlines():
    if not line.startswith("| ") or line.startswith("| Discipline") or line.startswith("|---"): continue
    cells = [c.strip() for c in line.strip("|").split("|")]
    for cell in cells[1:3]:                                   # Think + Do columns
        named |= set(re.findall(r"`([a-z0-9][a-z0-9-]*\*?)`", cell))
named = {n for n in named if not n.startswith("mkt-")}
def installed(n):
    return any(x.startswith(n[:-1]) for x in allnames) if n.endswith("*") else n in allnames
missing = sorted(n for n in named if not installed(n))
check(f"ownership map names {len(named)} skills, all installed", not missing, missing)
unmapped = [s for s in kit_skills if s != "marketing-kit" and f"`{s}`" not in router]
check("every kit skill has a place in the brain", not unmapped, unmapped)
for n in ("analytics", "revops"):
    check(f"router tells agents `{n}` is deliberately not installed", f"`{n}` skill is deliberately not installed" in router)
check("router: event-driven loops, no cron", "No cron, no timers" in router)
check("router: mobile first rule", "**Mobile first**" in router)
sys.exit(1 if fails else 0)
