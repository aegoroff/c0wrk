# Search Providers

The `web_search` tool is backed by a pluggable provider, configured in
`config.yaml` (`search.provider`) or in **Settings → Search**. This guide
helps you pick one and go from zero to a working search setup.

## Recommendation: API-backed providers

**Use `brave`, `tavily`, or `exa`.** All three are API-backed search engines
with free tiers, no anti-bot rate limiting to fight, and reliable organic
results. The DuckDuckGo fallout of October 2025 (silent empty results caused
by per-IP anomaly challenges) showed that HTML scraping can never be a
*reliable default* — c0wrk now fails loudly on such responses, but the
API-backed path is the one that just works.

| Provider | `search.provider` | Free tier | Good for |
| -------- | ----------------- | --------- | -------- |
| Tavily   | `tavily`          | Yes (1 000 credits/month at the time of writing) | General agent search; LLM-oriented results API |
| Brave Search | `brave`       | Yes (free tier with query quota) | General web search with an independent index |
| Exa      | `exa`             | Yes (free credits to start) | Semantic / research-style queries |

### Getting an API key

1. Create an account at the vendor's developer portal (brave.com/search/api
   for Brave, tavily.com for Tavily, exa.ai for Exa) and copy the API key
   from the dashboard's free tier.
2. Put the key into `~/.c0wrk/config.yaml` — or, preferably, keep it out of
   the file and reference an environment variable:

   ```yaml
   search:
     provider: "tavily"
     api_key: "${TAVILY_API_KEY}"
   ```

   `${VAR}` patterns in config values are expanded at runtime (see
   `config.example.yaml`), so the secret never has to live on disk. Export
   the variable in your shell profile — the desktop app resolves it from the
   launch environment.

The same settings are available in **Settings → Search**: pick the provider
and paste the key (it is stored in the config and masked in the UI).

## Fully self-hosted: SearXNG

`searxng` targets a **self-hosted** [SearXNG](https://docs.searxng.org/)
instance — the ToS-clean path with no third-party API keys: you control the
IP and the query rate, and SearXNG aggregates the upstream engines
server-side. Many public instances disable JSON output and some run their own
bot checks, so self-hosting is the supported setup.

1. Run an instance (docker-compose):

   ```yaml
   # docker-compose.yml
   services:
     searxng:
       image: searxng/searxng:latest
       ports:
         - "127.0.0.1:8888:8080"
       volumes:
         - ./searxng:/etc/searxng
       environment:
         - SEARXNG_BASE_URL=http://127.0.0.1:8888/
   ```

2. Enable JSON output in `./searxng/settings.yml` — without this the
   instance answers search requests with the HTML UI and c0wrk reports an
   explicit error pointing at this setting:

   ```yaml
   search:
     formats:
       - html
       - json
   ```

3. Point c0wrk at the instance:

   ```yaml
   search:
     provider: "searxng"
     base_url: "http://127.0.0.1:8888" # default when omitted
   ```

   The URL may also be an environment reference (`base_url:
   "${SEARXNG_URL}"`). A missing or malformed `base_url` fails with an
   explicit configuration error — the `web_search` tool is never silently
   missing.

## DuckDuckGo: best-effort only

`duckduckgo` scrapes the HTML endpoint (DuckDuckGo has no organic-results
API). Since DuckDuckGo's anti-bot rollout it is subject to per-IP rate
limiting: after a handful of requests the endpoint answers with an
anomaly/CAPTCHA challenge (HTTP 202). c0wrk detects the challenge and returns
an explicit "rate limited" error instead of a silent "No results found", and
the scraper paces itself and retries with backoff — but expect intermittent
failures. Selecting it in Settings shows a warning pointing at the
API-backed alternatives. Use it only as a last-resort fallback.

## Which one fits which use case?

- **Just want search to work** → `tavily` (or `brave`): free API key, one
  config line.
- **No third-party services at all** → self-hosted `searxng`.
- **Semantic/research queries** → `exa`.
- **No API key and no instance available** → `duckduckgo`, understanding it
  is rate-limited by design.
