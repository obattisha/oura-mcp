# Oura MCP server

A remote MCP server on Cloudflare Workers (free plan) that gives Claude read-only access to your Oura Ring data. Claude signs in through OAuth: the Worker sends you to Oura's login, stores the resulting Oura tokens in KV, and refreshes them automatically. Only the Oura account in `ALLOWED_OURA_EMAIL` can connect.

## Tools

| Tool | What it returns |
| --- | --- |
| `get_daily_summary` | One row per day: sleep, readiness, activity, stress and SpO2 scores with contributors |
| `get_collection` | Raw documents from any date-based collection (`sleep`, `workout`, `session`, `enhanced_tag`, `daily_resilience`, `vO2_max`, …). High-resolution series are dropped unless `include_timeseries` is true |
| `get_heart_rate` | Heart rate aggregated per hour and source, up to 7 days |
| `get_personal_info` | Profile (age, weight, height, sex) |

Date ranges default to the last 7 days.

## Setup

**1. Cloudflare.** Create a free account at dash.cloudflare.com, then:

```sh
npm install
npx wrangler login
npx wrangler kv namespace create OAUTH_KV   # paste the printed id into wrangler.jsonc (already set for this deployment)
```

**2. Deploy once to learn your URL.**

```sh
npx wrangler deploy
```

This prints something like `https://oura-mcp.<your-subdomain>.workers.dev`.

**3. Oura API application.** Oura requires OAuth for API access (personal access tokens were removed in December 2025). Sign in at https://cloud.ouraring.com/oauth/applications (or https://developer.ouraring.com/applications), create an application, and set its redirect URI to:

```
https://oura-mcp.<your-subdomain>.workers.dev/callback
```

Copy the client ID and secret straight into the next step; the secret may only be shown once.

**4. Secrets.**

```sh
npx wrangler secret put OURA_CLIENT_ID
npx wrangler secret put OURA_CLIENT_SECRET
openssl rand -hex 32 | npx wrangler secret put COOKIE_ENCRYPTION_KEY
```

Check that `ALLOWED_OURA_EMAIL` in `wrangler.jsonc` matches the email on your Oura account, then `npx wrangler deploy` again.

**5. Connect Claude.** In claude.ai, open Settings → Connectors → Add custom connector and enter `https://oura-mcp.<your-subdomain>.workers.dev/mcp`. You'll see an approval page, then Oura's login.

## Using mcp.battisha.com instead

A Worker custom domain only works if Cloudflare manages the domain's DNS. A CNAME added in InfinityFree's DNS panel won't work. To use the custom domain:

1. Add battisha.com to Cloudflare (free plan) and copy over the existing DNS records Cloudflare doesn't auto-import, so the InfinityFree site keeps working.
2. Change the domain's nameservers at your registrar to the ones Cloudflare gives you.
3. Uncomment `routes` in `wrangler.jsonc`, deploy, and add `https://mcp.battisha.com/callback` as a redirect URI on the Oura app.

If you'd rather leave DNS alone, the workers.dev URL works fine. Nobody sees it except your Claude connector settings.

## Local development

Create `.dev.vars` with `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET` and `COOKIE_ENCRYPTION_KEY`, add `http://localhost:8788/callback` as a redirect URI on the Oura app, and run `npm run dev`. Test with `npx @modelcontextprotocol/inspector` pointed at `http://localhost:8788/mcp`.
