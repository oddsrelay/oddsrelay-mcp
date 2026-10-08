# Changelog

## 0.1.0 (unreleased)

First version, built on the `oddsrelay` client and the OddsRelay API's OpenAPI document `2026-07-08`.

- Seven read-only tools over stdio: `sports`, `events`, `bookmakers`, `coverage`, `odds`, `event_odds`, `usage`.
- `odds` and `event_odds` ask for a quote first and refuse a call priced above `max_tokens`, spending nothing.
- `odds` takes one sport and the bookmakers you name.
- Replies cut to `limit` rows with a note counting the rest; `next_cursor` on paged tools.
- `coverage` returns one product as flat rows, filtered by bookmaker or sport, with or without a key.
- API errors returned as tool errors with the error code and, where sent, the accepted values.
- The key read from `ODDSRELAY_KEY` only, and hidden from every reply and error.
- `server.json` for the MCP registry, as `io.github.oddsrelay/oddsrelay-mcp`.
