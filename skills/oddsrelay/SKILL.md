---
name: oddsrelay
description: Read UK and Irish bookmaker and exchange odds from the OddsRelay API (raw prices per bookmaker, or matched boards that line up each bookmaker's back price with the exchange lay price and its liquidity), and historical bookmaker odds. Use when the user asks for odds, prices, a bookmaker's margin, an each-way, extra-place, BOG, 2Up or dutching board, historical odds, an event's price history, a day's closing prices, which bookmakers carry a sport, or how many API tokens a call would cost. Needs an OddsRelay API key in ODDSRELAY_KEY.
---

# OddsRelay odds data

OddsRelay is a pre-match odds feed for the UK and Ireland: every bookmaker's own prices (the raw board), and matched
boards where each bookmaker back price sits beside the best exchange lay price and the liquidity at that lay. The API
is documented at https://oddsrelay.io/docs and described by its OpenAPI file, https://api.oddsrelay.io/v2/openapi.json
(no key needed to read it). Read that file before using a parameter this skill does not name.

## Two ways in

1. **The MCP server** (preferred when the client supports MCP): `npx -y oddsrelay-mcp`, with `ODDSRELAY_KEY` set. Its
   tools (`sports`, `events`, `bookmakers`, `coverage`, `odds`, `event_odds`, `usage`) price every call before it runs
   and refuse a call above a per-call cap. See this repository's README. It does not wrap the historical routes yet:
   use HTTPS for those.
2. **HTTPS**: the key from `ODDSRELAY_KEY` as a bearer token in the `Authorization` header, base
   `https://api.oddsrelay.io`.
   Ask for `Accept-Encoding: gzip`. Never print the key, write it to a file or paste it into a message.

## Spend nothing by accident

- Discovery is free: `GET /v2/sports`, `GET /v2/events?sport=<key>`, `GET /v2/bookmakers`, `GET /v2/coverage`,
  `GET /v2/usage` (your plan, balance and key scope), `GET /v2/pricing` (the price table), `GET /v2/historical/files`
  (the list of bulk history files).
- Data routes spend tokens: `GET /v2/odds/raw`, `GET /v2/odds/event/{id}`, `GET /v2/odds/{type}` where `type` is one
  of the matched boards the coverage route lists (`standard`, `2up`, `dutching`, `each-way`, `extra-place`, `bog`).
- History routes spend tokens too: `GET /v2/historical/odds/raw` (the raw board as of an instant; `date` and `sports`
  required, gzip only, paged by `cursor`), `GET /v2/historical/events/{id}/odds` (one event's price changes; `from`
  required), `GET /v2/historical/closing` (a day's closing lines; `date` as `YYYY-MM-DD` and `sports` required) and
  `GET /v2/historical/files/{tier}/{sport}/{file}` (one bulk file, gzip CSV bytes: save them as they come). Their prices
  are in `GET /v2/pricing` under `regions.uk.historical`.
- **Quote first.** Add `quote=true` to any data call: it returns `{cost, remaining, rate_card}` and spends nothing.
  Tell the user the cost and ask before any call that costs more than they have agreed to.
- Narrow every call: `sports` (a sport key or prefix such as `soccer` or `horse_racing`), `bookmakers`, `markets`
  (such as `h2h` or `totals`), `commenceTimeFrom` and `commenceTimeTo`. A narrow call costs a fraction of a whole board.
- The raw board is paged: follow `meta.next_cursor` (pass it back as `cursor`) until it is absent. A cursor expires
  soon after it is issued (the OpenAPI file gives how soon), so page straight through.

## Reading the data

- Prices are decimal odds. A raw event lists `bookmakers`, each with its `markets` and their `outcomes`
  (`name`, `price`), named the way that bookmaker names them.
- A matched board's outcomes carry the bookmakers' back prices beside the exchange lay price and the liquidity at that
  lay, on the same fixture, market and line.
- Each response's `meta` carries when the board was produced (`processed_at`) and, on matched boards, each
  bookmaker's last read (`last_seen`): say how old the data is from those, never guess.
- A bookmaker's margin on a market is the sum of 1/price over its outcomes, minus 1.

## Limits to tell the user

- Pre-match only: no in-play prices, no results.
- Historical odds (`/v2/historical/*`) are bookmakers only: no exchange history (an `exchanges` parameter or
  `exchangesOnly=true` is 403 `exchange_history_unavailable`) and no starting prices. They are recorded from
  17 October 2026 and released a UTC day at a time, the night after the day, so today's prices come from the live
  routes.
- Bulk files: an account whose scope narrows history, or whose plan names a bookmaker list, is 403
  `files_need_whole_scope`. Only so many downloads run at once, per account and in all: one more is 429
  `too_many_downloads`, so retry after its `Retry-After` seconds. A download is charged in full before its first byte,
  so one cut off keeps its charge.
- Pull only: no websocket, webhook or stream on the self-serve plans.
- One region per key; the UK and Ireland is the one on sale.
- The self-serve plans are for the account holder's own use. A product that shows the data to other people runs on
  Enterprise (https://oddsrelay.io/pricing).
- OddsRelay is a data supplier. It gives no tips and takes no bets: describe what the prices are, never what to bet.

## Get a key

Sign up at https://app.oddsrelay.io/signup and copy the key from the dashboard. Plans and token prices:
https://oddsrelay.io/pricing.
