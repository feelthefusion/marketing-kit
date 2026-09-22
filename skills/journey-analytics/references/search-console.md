# Google Search Console (optional, off by default)

This is the one outside source the kit allows, and only because search-query data exists only
at Google: which searches showed your pages, impressions, CTR and average position. It's
read-only and collects nothing from your visitors. Everything after the click stays
first-party.

## Turn it on or off (your setting)
```bash
mkt-settings                 # shows every switch and its state
mkt-settings gsc on          # registers the gsc MCP in Claude Code + Hermes (when credentials exist)
mkt-settings gsc off         # unregisters it everywhere
```
The switch lives in `~/.config/marketing-kit/settings.env` (`MKT_GSC=on|off`). If you edit that
file by hand, run `mkt-settings apply` afterwards. The kit installers respect the switch on every
re-run, and `mkt-mcp gsc` refuses to start while it's off.

## Credentials (once)
1. In Google Cloud, create a service account and download its JSON key. Also enable the
   "Google Search Console API".
2. In Search Console, go to Settings → Users and permissions → Add user, enter the service
   account's email, and give it **Restricted** permission (read-only is enough).
3. Add `GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/key.json` to
   `~/.config/marketing-kit/secrets.env`, then run `mkt-settings gsc on`.

Server: `mcp-search-console@latest` (AminForou/mcp-gsc). It's a community server, since Google
ships no official one. It's launched through `mkt-mcp gsc`.

## How to use it with first-party data
- Search Console gives query → page → clicks. Your `crm_events` gives landing page →
  signup/revenue (analytics.sql #2, #5). Join the two **on the page path** to find queries that
  bring revenue, not just clicks.
- Its numbers are Google's (sampled, delayed 2–3 days, and some queries anonymized). Never
  reconcile them 1:1 with your sessions.
- Useful asks: "pages with high impressions and low CTR", "queries at position 8–15 (the page-2
  edge)", "pages whose clicks dropped more than 30% over 28 days".
