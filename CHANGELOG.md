# Changelog

## Unreleased

Three new tools, so an assistant can read every region OddsRelay serves, and the Agent Skill and README brought up to
date.

- `raw_odds`: the raw board for one sport, each bookmaker's own prices. `region` takes one code, or several
  international codes joined by commas (`us,global`), read as one board; `uk` is asked alone. `in_play` adds in-play
  events or reads them alone. Paged, priced first and refused above `max_tokens`.
- `history`: historical odds for one sport and one region, as the raw board at a time you name (`snapshot`) or a day's
  opening and closing prices (`closing`). Paged, priced first and refused above `max_tokens`. A date before a region's
  first day comes back with the earliest date the archive holds.
- `regions`: the region codes your key reads. Costs no tokens.
- `bookmakers` takes `region`, and `event_odds` takes `in_play`.
- Every tool's description says which regions it serves: the matched boards (`odds`) are for the UK & Ireland only,
  and the lists, `raw_odds`, `event_odds` and `history` serve every region.
- The README has a Regions section and first questions for a region outside the UK & Ireland.
- The Agent Skill, `skills/oddsrelay/SKILL.md`, describes the feed as it is now: raw prices for the UK & Ireland and
  20 more regions, with the matched boards and exchange prices for the UK & Ireland only (a matched board in another
  region is 403 `product_not_in_region`).
- Regions in the Agent Skill: a self-serve key reads every region, each at its own token price; one `region` a call,
  except that the raw board takes a comma list of international codes (`region=us,global`), priced as their sum, and
  `uk` is always asked alone.
- In-play in the Agent Skill: `inPlay=include` or `inPlay=only` on the raw board and on one event's prices, and
  `inPlay=only` on the `standard` and `dutching` boards.
- Historical odds in the Agent Skill: `region` as on the live routes, the exchanges beside the bookmakers in the UK &
  Ireland, bookmakers only from 16 November 2026 in each other region, and prices under `regions.<code>.historical`.
- The Agent Skill names the new tools.

## 0.1.2 (2026-10-29)

A Gemini CLI extension, an Agent Skill and new README text: the code is the same as 0.1.1, apart from the version it
reports.

- `gemini-extension.json`: `gemini extensions install https://github.com/oddsrelay/oddsrelay-mcp` installs the server
  as a Gemini CLI extension, asks for your API key, keeps it in your system keychain and passes it to the server as
  `ODDSRELAY_KEY`.
- Each release now carries the Gemini CLI extension beside `oddsrelay-mcp.mcpb`, as `darwin.oddsrelay.tar.gz`,
  `linux.oddsrelay.tar.gz` and `win32.oddsrelay.tar.gz`: one archive under the names Gemini CLI looks for, so it no
  longer takes the Claude Desktop bundle for the extension. The release workflow builds and attaches all four files.
- An Agent Skill, `skills/oddsrelay/SKILL.md`, for assistants that load skills: when to use OddsRelay, how to price a
  call before it spends tokens, how to read the boards, and historical odds. The Gemini CLI extension loads it too.
- The README and the Agent Skill say the paid plans are for personal use; any business, and any product that serves
  other people, runs on Enterprise.

## 0.1.1 (2026-10-12)

README, package page and bundle text only: the code is the same as 0.1.0, apart from the version it reports.

- A "Get a key" section: where to sign up, and what the Free plan gives you.
- Links to the OddsRelay clients, the Google Sheets template, the examples and the docs.
- The README and the bundle's description say `max_tokens` caps each call, and that the assistant is told to ask
  you before raising it.

## 0.1.0 (2026-10-09)

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
- `manifest.json` for an MCP Bundle, and `npm run bundle` to build `oddsrelay-mcp.mcpb`: a one-click install in
  Claude Desktop that asks for the key in a masked field.
