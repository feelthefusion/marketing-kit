---
name: campaign-harden
description: "Use before any campaign, sequence, email, SMS, landing page, or upsell/retention trigger goes live, or when asked to review, critique, stress-test or 'grill' copy or a campaign. Runs the persona grill (does this speak to what the data says this segment cares about?), the claim check (every number, feature and price verified against DB/orders/product), the de-slop pass (copy-editing + humanizer), and the mkt-preflight gate (schema, variables, links/UTMs, SMS segments). Blocks launch until preflight is GREEN."
---

# Campaign Harden (persona grill + copy integrity + preflight)

Generic copy and broken personalization are the two ways a custom CRM loses to a SaaS one.
This skill is the gate between a draft and a send. It argues against the campaign with the
customer's own data, then proves the mechanics with a script.

## Inputs
- the repo's `CLAUDE.md` / `AGENTS.md` and the "Copy rules" section of `.agents/growth-stack.md` —
  product-specific wording constraints override every marketing skill's defaults
- `campaigns/<id>.campaign.json` (template: kit `templates/campaign.example.json`) + `<id>.sql`
- `.agents/product-marketing.md` (personas, verbatim customer language, objections)
- evidence from journey-analytics (what the segment actually does) and the ledger

## 1. Persona grill — answer each with evidence, not adjectives

Ask these as a skeptical member of the target segment. Each answer cites a query result, a
analytics report (journey-analytics), a customer quote, or a ledger entry. "Unknown" is allowed; invented is not.

1. **Who exactly?** Name the segment by its SQL filter. What share of revenue/users is it?
2. **Why now?** Which observed behavior (event, limit hit, inactivity, plan change) triggers
   this, and how many days since?
3. **What do they care about?** Quote their words (reviews, support, interviews in
   product-marketing.md). Does the subject line/first SMS line use that language?
4. **Why would they ignore this?** Top objection for this persona; where does the copy answer it?
5. **What does the recipient get?** A concrete outcome in their terms, not a feature name.
6. **Is the ask one ask?** One CTA per message; the link lands on the page that fulfills it.
7. **Upsell/retention fit** — does the offer match the trait that triggered it (limit hit →
   the plan that removes that limit; inactivity → the feature they used most)?
8. **What did we learn last time?** `mkt-ledger recall` — if a similar play failed, what differs?
9. **Channel choice** — which channel (or both) lands this moment best?
10. **What would make this a mistake?** A wrong variable, a price that changed, a link to a
    page that moved, an offer that no longer exists.

Rewrite until every answer is concrete. Keep the grill Q&A in the PR/campaign notes.

## 2. Claim check — copy integrity

For every factual token in the copy — numbers, prices, plan names, feature names, dates,
"3 changes since", "you saved X":
- trace it to a source: a column in the audience query (personalized), the app's own plans/prices (DB or pricing config),
  the codebase (feature exists, route exists), or the ledger (social-proof numbers);
- if it comes from a column, that column must be in `audience.columns`; if it can be null,
  give a fallback `{{col | fallback}}` or list it in `required_columns` and filter nulls in SQL;
- links must resolve (curl the URL, or grep the router), carry
  `utm_source/utm_medium/utm_campaign=<id>`, and land on the page that fulfills the ask.

## 3. De-slop

`copy-editing` (sweep for clarity, specificity, proof) → `humanizer` (remove AI tells) →
re-read against voice rules in product-marketing.md. `mkt-preflight` flags the kit's
banned-phrase list (`templates/banned-phrases.txt`) plus the repo's
`.agents/banned-phrases.txt` — add brand-specific bans there, not to the kit copy.

## 4. Mechanical gate — must be GREEN

```bash
mkt-preflight campaigns/<id>.campaign.json --db     # --strict to fail on warnings too
```
Checks: required fields + enums, one primary metric, holdout declared, idempotency key with
`{{contact_id}}`, every `{{var}}` is a real column (`--db` runs the SQL with `LIMIT 0`),
leftover placeholders, UTM discipline and `utm_campaign == id`, subject/preheader length,
sender present, SMS GSM-7/UCS-2 + segment count at maximum variable length.
Paste the output. RED → fix the cause in the spec/copy/SQL, never loosen the check.

## 5. Proof send

Render with a real contact row (the owner's own), send to the owner through the real path
(lifecycle-engine test mode), read it on a phone. Only then activate.

## Works with →
- Marketing skills `copywriting`, `emails`, `sms`, `copy-editing`, `marketing-psychology`,
  `offers` (draft) → **humanizer** (de-slop) → this gate → **lifecycle-engine** (send).
- **journey-analytics** / **growth-data** — the evidence the grill demands.
- **playbook-ledger** — save the grill's surviving insight (`mkt-ledger save persona|voice`).
- Starter Kit **verify-gate** — `mkt-init` adds `mkt-preflight campaigns/*.campaign.json` to `verify.sh`.
