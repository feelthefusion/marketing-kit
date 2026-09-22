---
name: playbook-ledger
description: "Use at the START of any marketing/growth task to recall prior ICPs, personas, voice rules, offers, campaign results and seasonal plays, and at the END to save what was learned — via mkt-ledger on the local Supermemory server (container 'growth'). Defines what to save, the record format, and when a memory is stale."
---

# Playbook Ledger (Supermemory)

Growth compounds only if results are remembered. The ledger is the Supermemory container
`growth` on the local server (`localhost:6767`), shared by Claude Code and Hermes through one
CLI:

```bash
mkt-ledger recall "reactivation email paid inactive"      # hybrid search, newest facts first
mkt-ledger save lift "winback-10d-inactive: +6.1pt 7d return vs 10% holdout (n=412), +\$1.8k MRR, 2026-10"
mkt-ledger doctor
```

The host's own Supermemory integration (Claude Code plugin hooks / Hermes memory provider)
still captures conversation context automatically; `mkt-ledger` is for **deliberate,
structured** growth facts that must survive and be findable by kind.

## Kinds and formats (one fact per save, ≤ 3 sentences)

| kind | save when | format |
|------|-----------|--------|
| `icp` | ICP defined/changed | who · pain · trigger · where found · value per customer |
| `persona` | grill yields a durable insight | persona · what they respond to · what they ignore · evidence |
| `voice` | a voice/style rule is decided | rule · example do · example don't |
| `offer` | an offer is tested | offer · segment · take rate · margin effect |
| `campaign` | a campaign launches | id · goal · segment SQL name · channels · holdout · primary metric |
| `lift` | a result is read | id · lift ± uncertainty · n per arm · revenue · window · date |
| `seasonal` | a timing pattern is seen | period · segment · effect size · years observed |
| `channel` | deliverability/channel learning | channel · finding · numbers (bounce, opt-out, CTR) |
| `insight` | an analytics finding | metric · segment · finding · query name |
| `decision` | a strategy decision | decision · why · what would reverse it |

Always include numbers, n, and a date — a lift with no n is noise in six months.

## Rules
- Recall before proposing; cite the entries you used ("ledger: winback lift 2026-10").
- A newer entry on the same id/segment supersedes older ones; say so when you rely on it.
- Never save secrets, raw PII (emails, phones), or unverified numbers.
- The project is tagged automatically (git repo name; override `MKT_PROJECT`), so
  cross-project plays are recallable ("what worked for aura's churn?").

## If the ledger is down
`mkt-ledger doctor` → not reachable: macOS `launchctl kickstart -k gui/$(id -u)/com.supermemory.local`,
else run `supermemory-server`. Re-run the kit installer to rewire keys. Keep working; save
the pending entries once it is back.

## Works with →
- Every kit component: **marketing-kit** step 1 (recall) and step 9 (save).
- `product-marketing` skill — durable positioning lives in `.agents/product-marketing.md`;
  the ledger holds what was *learned*, the doc holds what is *true now*.
