# Changelog

## 0.1.0 (unreleased)

First version, built on the `oddsrelay` client and the OddsRelay API's OpenAPI document `2026-07-08`.

- Seven tools over stdio, none of which writes anything: `sports`, `events`, `bookmakers`, `coverage`, `odds`, `event_odds`, `usage`.
- `odds` and `event_odds` ask for a quote first and refuse a call priced above `max_tokens`, spending nothing.
  They only read, but their annotations mark them as calls with a cost rather than read-only, so clients that
  confirm such calls ask first.
- `odds` takes one sport and the bookmakers you name.
- Replies cut to `limit` rows and to a readable size, with a note counting the rest. On paged tools, `next_cursor`
  goes on from the first row not shown.
- `coverage` returns one product as flat rows, filtered by bookmaker or sport, with that product's market keys. It
  sends no key.
- API errors returned as tool errors with the error code and, where sent, the accepted values.
- The key read from `ODDSRELAY_KEY` only, and hidden from every reply and error.
- `server.json` for the MCP registry, as `io.github.oddsrelay/oddsrelay-mcp`.
