# oddsrelay-mcp

An MCP server that gives an AI assistant read access to OddsRelay: each bookmaker's own prices (the raw board) and
historical odds for the UK & Ireland and every other region OddsRelay serves, in-play prices included, the UK & Ireland
matched boards, the prices for one event, and the sport, event, bookmaker, region and coverage lists behind them. It
is read-only, and every call that spends tokens is priced first and refused above a per-call cap (`max_tokens`). The
assistant is told to ask you before raising it.

It works with Claude Desktop, Claude Code, Cursor and any other client that starts MCP servers over stdio, and it is
built on the [`oddsrelay`](https://www.npmjs.com/package/oddsrelay) TypeScript client.

API docs: https://oddsrelay.io/docs

## Get a key

Sign up at [app.oddsrelay.io/signup](https://app.oddsrelay.io/signup) and copy your key from the dashboard.
Free gives you 50,000 tokens for 14 days from sign-up, with no card, then no tokens until you choose a plan, on the same key. [Plans and token prices](https://oddsrelay.io/pricing).
Paid plans are for personal use. Any business, even one using the data only in-house, and any product that serves
other people runs on Enterprise; a business can try the data on Free first.

## Set up

You need an OddsRelay API key (Get a key, above). The server reads the key from `ODDSRELAY_KEY`. The bundle and the Gemini CLI extension set it for you; the other routes set it in your MCP client's config and need
Node 18 or later.

### Claude Desktop (one-click bundle)

Download `oddsrelay-mcp.mcpb` from the [latest release](https://github.com/oddsrelay/oddsrelay-mcp/releases/latest)
and double-click it to install it in Claude Desktop, which asks for one setting: your API key. The setting is marked
sensitive, so Claude Desktop masks it, and it passes the key to the server as `ODDSRELAY_KEY`. The bundle carries
everything the server needs and runs on the Node built into Claude Desktop, so you need no Node of your own.

### Claude Code

```sh
claude mcp add --transport stdio oddsrelay --env ODDSRELAY_KEY=your_key_here -- npx -y oddsrelay-mcp
```

### Claude Desktop (config file)

Settings, Developer, Edit Config opens `claude_desktop_config.json`. Add the server, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "oddsrelay": {
      "command": "npx",
      "args": ["-y", "oddsrelay-mcp"],
      "env": { "ODDSRELAY_KEY": "your_key_here" }
    }
  }
}
```

### Cursor

Add the same `mcpServers` block to `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project).

The key sits in that config file as plain text, so keep the file out of anything you commit.

### Gemini CLI

```sh
gemini extensions install https://github.com/oddsrelay/oddsrelay-mcp
```

Gemini CLI installs the extension from the latest release, then asks for your API key, keeps it in your system
keychain and passes it to the server as `ODDSRELAY_KEY`. The extension also loads the Agent Skill below.

## First questions

Ask your assistant:

> Using OddsRelay, which bookmakers carry tennis on the standard board?

That calls `coverage`, which costs no tokens. Then:

> Show the OddsRelay standard board for soccer at Ladbrokes and William Hill, first five events.

The assistant finds the bookmaker keys with `bookmakers`, then calls `odds`, which is priced before it runs.

For a region outside the UK & Ireland, ask for raw prices:

> Using OddsRelay, show the raw basketball prices in the US region, first five events, h2h only.

The assistant finds the region code with `regions`, then calls `raw_odds`, priced first in the same way. And for
historical odds:

> Using OddsRelay, show yesterday's closing prices for soccer in the US region, first five events.

That calls `history`.

## Agent Skill

[`skills/oddsrelay/SKILL.md`](skills/oddsrelay/SKILL.md) is an Agent Skill for assistants that load skills (Claude
Code, Claude.ai and other skill-aware clients): when to reach for OddsRelay, how to quote a call before it spends
tokens, and how to read the boards. It works with this server or with plain HTTPS.

## Tools

| Tool | What it reads | Regions | Tokens |
|---|---|---|---|
| `sports` | Sport and competition keys, paged | every region | none |
| `events` | The events of one sport, with their ids, paged | every region | none |
| `bookmakers` | The bookmaker and exchange keys of one region | every region | none |
| `regions` | The region codes your key reads | | none |
| `coverage` | Which bookmakers carry which sports on one product, and the product's market keys | `raw` in every region; the matched products in the UK & Ireland | none |
| `odds` | A matched board (`standard`, `2up`, `dutching`, `each-way`, `extra-place` or `bog`) for one sport at the bookmakers you name | UK & Ireland only | priced first, capped |
| `raw_odds` | The raw board for one sport: each bookmaker's own prices, in play too with `in_play`, paged | every region; several international codes in one call | priced first, capped |
| `event_odds` | One event's prices at each bookmaker and exchange carrying it, narrowed to the bookmakers and markets you name | every region | priced first, capped |
| `history` | Historical odds for one sport: the raw board as it stood at a time you name (`snapshot`), or a day's opening and closing prices (`closing`), paged | every region | priced first, capped |
| `usage` | Your plan, token balance, reset time, key scope and regions | | none |

## Regions

`regions` lists the codes your key reads: `uk` is the UK & Ireland, and every other code is an international region.
Each tool takes one `region` code a call. `raw_odds` alone also takes several international codes joined by commas
(`us,global`), read as one board and priced as their sum; `uk` is always asked alone. Leave `region` out and the API
uses `uk`, or refuses with `region_required` and names the code to send.

The matched boards (`odds`) and exchange prices are for the UK & Ireland only: in any other region `odds` is refused
with `product_not_in_region`, and `raw_odds`, `event_odds` and `history` are the tools to use.

`history` reads the UK & Ireland from 17 October 2026, with exchange prices beside the bookmakers' (`bookmakers_only`
leaves them out), and each other region, bookmakers only, from 16 November 2026. A date before a region's first day is
refused with `date_out_of_range` and the earliest date it holds. A day is added the night after it ends, so today's
prices come from `raw_odds`. The server does not wrap one event's price changes or the bulk history files: the
[docs](https://oddsrelay.io/docs) cover those.

## The token cap

`odds`, `raw_odds`, `event_odds` and `history` take a `max_tokens` argument with a small default. Before each call the server asks the
API what the call would cost (a quote, which spends nothing). If it would cost more than `max_tokens`, the server
makes no call, spends nothing and tells the assistant the price, so the assistant can narrow the filters or ask you
before it tries again with a higher `max_tokens`.

`odds` always takes one sport and the bookmakers you name, and `raw_odds` and `history` one sport, so each call stays
narrow. On `odds` and `event_odds` the cost is set by the filters you send; cutting the reply to `limit` rows does not
change it. `raw_odds` and `history` are paged: each call asks the API for `limit` events and each page is priced, and
a page too long to show whole is priced again when the assistant goes on from it, so name the markets and bookmakers
you want. Every reply from these four tools carries `tokens`: what the call cost and what is left.

All four only read, but their MCP annotations mark them as calls with a cost rather than read-only, so a client
that asks before such calls will ask you each time. `event_odds` reads the raw board, so it needs a key that can read raw odds.

## Replies

Replies are compact JSON. Long lists are cut to `limit` rows (each tool has its own default) and to a size an
assistant can read in one go, with a `more` note saying how many rows were left out and what to change to see them.
Paged tools return `next_cursor`, which the assistant passes back as `cursor`; a page cut short goes on from the
first row not shown.

Errors come back as tool errors with the API's error `code` and, where the API sends them, the values it accepts:
ask for an unknown bookmaker and the error lists the keys it accepts.

## Your key

The server reads the key only from `ODDSRELAY_KEY` and sends it only to `https://api.oddsrelay.io`, in the
`Authorization` header. It never puts the key in a tool reply or an error: if an error ever echoed it, it would be
replaced with `[hidden]`. The server logs nothing.

## What it does not do

No tool writes anything, reads or writes files, or calls any host but the OddsRelay API.

## Develop

```sh
npm ci
npm test
```

The tests run the server against a stubbed `fetch` and make no network calls. `npm run bundle` builds
`oddsrelay-mcp.mcpb` from `dist` and the installed dependencies: `manifest.json` describes the bundle, and
`.mcpbignore` keeps sources, tests and development packages out of it. To try the built server by hand,
`npx @modelcontextprotocol/inspector node dist/cli.js` opens it in the MCP Inspector.

## More from OddsRelay

- [oddsrelay-python](https://github.com/oddsrelay/oddsrelay-python): the Python client, `pip install oddsrelay`
- [oddsrelay-js](https://github.com/oddsrelay/oddsrelay-js): the JavaScript and TypeScript client, `npm install oddsrelay`
- [oddsrelay-r](https://github.com/oddsrelay/oddsrelay-r): the R client
- [oddsrelay-sheets](https://github.com/oddsrelay/oddsrelay-sheets): formulas and a template spreadsheet for Google Sheets
- [examples](https://github.com/oddsrelay/examples): short programs to copy, one folder each
- [Libraries and tools](https://oddsrelay.io/docs/libraries), the [docs](https://oddsrelay.io/docs), the [API reference](https://oddsrelay.io/docs/reference) and the [OpenAPI file](https://api.oddsrelay.io/v2/openapi.json)
- Contact: hello@oddsrelay.io

## License

MIT
