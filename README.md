# oddsrelay-mcp

An MCP server that gives an AI assistant read access to OddsRelay: matched boards, the prices for one event, and
the sport, event, bookmaker and coverage lists behind them. It is read-only, and every call that spends tokens is
priced first and refused above a cap, so an assistant cannot run down your token balance by accident.

It works with Claude Desktop, Claude Code, Cursor and any other client that starts MCP servers over stdio, and it is
built on the [`oddsrelay`](https://www.npmjs.com/package/oddsrelay) TypeScript client.

API docs: https://oddsrelay.io/docs

## Set up

You need an OddsRelay API key, which you create from your account at https://oddsrelay.io. The server reads the
key from `ODDSRELAY_KEY`. The bundle sets it for you; the other routes set it in your MCP client's config and need
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

## First questions

Ask your assistant:

> Using OddsRelay, which bookmakers carry tennis on the standard board?

That calls `coverage`, which costs no tokens. Then:

> Show the OddsRelay standard board for soccer at Ladbrokes and William Hill, first five events.

The assistant finds the bookmaker keys with `bookmakers`, then calls `odds`, which is priced before it runs.

## Tools

| Tool | What it reads | Tokens |
|---|---|---|
| `sports` | Sport and competition keys, paged | none |
| `events` | The events of one sport, with their ids, paged | none |
| `bookmakers` | Bookmaker and exchange keys | none |
| `coverage` | Which bookmakers carry which sports on one product, and the product's market keys | none |
| `odds` | A matched board (`standard`, `2up`, `dutching`, `each-way`, `extra-place` or `bog`) for one sport at the bookmakers you name | priced first, capped |
| `event_odds` | One event's prices at each bookmaker and exchange carrying it, narrowed to the bookmakers and markets you name | priced first, capped |
| `usage` | Your plan, token balance, reset time and key scope | none |

## The token cap

`odds` and `event_odds` take a `max_tokens` argument with a small default. Before each call the server asks the
API what the call would cost (a quote, which spends nothing). If it would cost more than `max_tokens`, the server
makes no call, spends nothing and tells the assistant the price, so the assistant can narrow the filters or ask you
before it tries again with a higher `max_tokens`.

`odds` always takes one sport and the bookmakers you name, so each call stays narrow. The cost is set by the filters
you send; cutting the reply to `limit` rows does not change it. Every reply from these two tools carries `tokens`:
what the call cost and what is left.

Both tools only read, but their MCP annotations mark them as calls with a cost rather than read-only, so a client
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

## Links

- Docs: https://oddsrelay.io/docs
- Website: https://oddsrelay.io
- TypeScript client: https://github.com/oddsrelay/oddsrelay-js
- Contact: hello@oddsrelay.io

## License

MIT
