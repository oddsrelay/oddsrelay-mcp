import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { InsufficientTokensError, OddsRelay, OddsRelayError, OverBudgetError } from "oddsrelay";
import type { FetchLike, Page, Result, Tokens } from "oddsrelay";
import { z } from "zod";

/** This package's version. package.json, server.json and manifest.json carry it too; tests keep them equal. */
export const VERSION = "0.1.2";

/** The most tokens a call may spend when the assistant passes no max_tokens. */
const DEFAULT_MAX_TOKENS = 500;

/** Characters of rows per reply, roughly 10k tokens of JSON: under the size where MCP clients start to warn. */
const REPLY_BUDGET = 30_000;

const INSTRUCTIONS =
  "Read-only tools for the OddsRelay odds API. sports, events, bookmakers, coverage and usage cost no tokens. " +
  "odds and event_odds spend tokens from the user's account: each asks the API for a price first and refuses " +
  "when that price is above max_tokens, so nothing is spent past that limit. Look up keys with sports and " +
  "bookmakers before calling odds, keep filters narrow, and ask the user before calling again with a higher " +
  "max_tokens.";

const NO_KEY = {
  error: "missing_key",
  message:
    "ODDSRELAY_KEY is not set. Add it to the env block of this server in your MCP client's config, then restart " +
    "the server.",
};

const READ_ONLY = { readOnlyHint: true, openWorldHint: true };
// Not read-only to a client: each call spends the user's tokens, so clients that confirm such calls will ask first.
const SPENDS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const BOARDS = ["standard", "2up", "dutching", "each-way", "extra-place", "bog"] as const;

// Every key the API hands out (sports, venues, markets) fits this; a comma never does, so one value stays one value.
const key = z.string().regex(/^[a-z0-9_.-]+$/, "a lowercase key such as soccer or william_hill");
const keys = (max: number) => z.array(key).min(1).max(max);
const region = key.optional().describe("Region code. Left out, the API uses uk.");
const time = z.string().optional();
const cursor = z.string().optional().describe("next_cursor from the previous reply, with the same other arguments");
const limit = (rows: string, byDefault: number) =>
  z.number().int().min(1).max(100).default(byDefault).describe(`Most ${rows} to return; a note counts the rest`);
const maxTokens = z
  .number()
  .int()
  .min(0)
  .default(DEFAULT_MAX_TOKENS)
  .describe("Refuse the call when its quoted price is above this many tokens. Ask the user before raising it.");

export interface ServerOptions {
  /** A fetch to use instead of the global one. Tests pass a stub. */
  fetch?: FetchLike;
}

/** The OddsRelay MCP server: read-only tools over the OddsRelay client, keyed from ODDSRELAY_KEY. */
export function createServer(options: ServerOptions = {}): McpServer {
  const apiKey = process.env.ODDSRELAY_KEY?.trim();
  // The key as it would appear raw and inside a JSON string; neither form may reach a tool's output.
  const secrets = apiKey ? [apiKey, JSON.stringify(apiKey).slice(1, -1)] : [];
  const hide = (text: string) => secrets.reduce((out, s) => out.replaceAll(s, "[hidden]"), text);
  const reply = (body: unknown, isError = false): CallToolResult => ({
    content: [{ type: "text", text: hide(JSON.stringify(body)) }],
    ...(isError ? { isError } : {}),
  });

  // A fresh client per call, so no ETag is sent and a repeat call never comes back as a 304 without data.
  // ponytail: repeats are charged again; keep one client plus a reply cache if repeat calls turn out to matter.
  // keyed false sends no key at all (an empty apiKey makes the client keyless).
  async function run(work: (client: OddsRelay) => Promise<unknown>, keyed = true): Promise<CallToolResult> {
    if (keyed && !apiKey) return reply(NO_KEY, true);
    try {
      return reply(await work(new OddsRelay({ apiKey: keyed ? apiKey : "", fetch: options.fetch })));
    } catch (err) {
      return reply(explain(err), true);
    }
  }

  const server = new McpServer({ name: "oddsrelay", version: VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "sports",
    {
      title: "Sports",
      description:
        "Lists sport and competition keys (such as soccer or soccer_epl) for the sport filter of odds and events. " +
        "Costs no tokens. Paged: pass next_cursor back as cursor.",
      inputSchema: { region, cursor, limit: limit("sports", 50) },
      annotations: READ_ONLY,
    },
    (a) =>
      run(async (c) => {
        const at = unpack(a.cursor);
        return page(body(await c.sports({ region: a.region, cursor: at.api })), at, a.limit, "sports");
      }),
  );

  server.registerTool(
    "events",
    {
      title: "Events",
      description:
        "Lists the events of one sport with their ids, for event_odds. Costs no tokens. " +
        "Paged: pass next_cursor back as cursor.",
      inputSchema: {
        sport: key.describe("Which sport: tennis, or a competition key from the sports tool"),
        region,
        commence_from: time.describe("Earliest start time, ISO 8601"),
        commence_to: time.describe("Latest start time, ISO 8601"),
        cursor,
        limit: limit("events", 25),
      },
      annotations: READ_ONLY,
    },
    (a) =>
      run(async (c) => {
        const at = unpack(a.cursor);
        const res = await c.events({
          sport: a.sport,
          region: a.region,
          commenceTimeFrom: a.commence_from,
          commenceTimeTo: a.commence_to,
          cursor: at.api,
        });
        return page(body(res), at, a.limit, "events");
      }),
  );

  server.registerTool(
    "bookmakers",
    {
      title: "Bookmakers",
      description: "Lists the bookmaker and exchange keys that odds, event_odds and coverage take. Costs no tokens.",
      annotations: READ_ONLY,
    },
    () => run(async (c) => ({ venues: body(await c.bookmakers()).data })),
  );

  server.registerTool(
    "coverage",
    {
      title: "Coverage",
      description:
        "Shows which bookmakers carry which sports on one product, and that product's market keys (the values " +
        "odds takes as markets). Filter by bookmaker or sport. Costs no tokens and sends no key.",
      inputSchema: {
        product: key.default("standard").describe("standard, 2up, dutching, each-way, extra-place, bog or raw"),
        bookmaker: key.optional().describe("Only this bookmaker or exchange key"),
        sport: key.optional().describe("Only this sport, such as soccer"),
        region,
        limit: limit("rows", 50),
      },
      annotations: READ_ONLY,
    },
    (a) =>
      // Read without a key: only that view lists each product's market keys.
      run(async (c) => {
        const cov = body(await c.coverage({ region: a.region }));
        if (!("markets" in cov)) throw new Error("coverage came back without market keys");
        const all = cov.products[a.product];
        if (!all) throw new Error(`no product "${a.product}" in coverage; products: ${Object.keys(cov.products).join(", ")}`);
        const rows = all.filter((r) => (!a.bookmaker || r.bookmaker === a.bookmaker) && (!a.sport || r.sport === a.sport));
        const where = { region: cov.region, generated_at: cov.generated_at, product: a.product };
        return { ...where, markets: cov.markets[a.product], ...trim(rows, a.limit, "rows") };
      }, false),
  );

  server.registerTool(
    "odds",
    {
      title: "Odds",
      description:
        "Reads a matched board (bookmaker back prices with exchange lay prices) for one sport at the bookmakers " +
        "you name. Spends tokens: priced first, and refused when it would cost more than max_tokens.",
      inputSchema: {
        type: z.enum(BOARDS).describe("Which matched board"),
        sport: key.describe("Which sport: soccer, or a competition key from the sports tool such as soccer_epl"),
        bookmakers: keys(40).describe("Bookmaker keys from the bookmakers tool"),
        exchanges: keys(4).optional().describe("Exchange keys; left out, every exchange on the board"),
        markets: keys(20).optional().describe("Market keys such as h2h; left out, every market on the board"),
        commence_from: time.describe("Earliest start time, ISO 8601"),
        commence_to: time.describe("Latest start time, ISO 8601"),
        region,
        limit: limit("events", 10),
        max_tokens: maxTokens,
      },
      annotations: SPENDS,
    },
    (a) =>
      run(async (c) => {
        const params = {
          region: a.region,
          sports: a.sport,
          bookmakers: a.bookmakers,
          exchanges: a.exchanges,
          markets: a.markets,
          commenceTimeFrom: a.commence_from,
          commenceTimeTo: a.commence_to,
        };
        const res = await c.odds(a.type, params, { maxTokens: a.max_tokens });
        const board = body(res);
        return { meta: board.meta, ...trim(board.data, a.limit, "events"), tokens: spent(res.tokens) };
      }),
  );

  server.registerTool(
    "event_odds",
    {
      title: "Event odds",
      description:
        "Reads one event's prices (id from events or odds) at each bookmaker and exchange carrying it, narrowed to " +
        "the bookmakers and markets you name. Needs a key that can read raw odds. Spends tokens: priced first, " +
        "and refused when it would cost more than max_tokens.",
      inputSchema: {
        id: key.describe("An event id such as or_evt_da71d5873e85"),
        bookmakers: keys(40).optional().describe("Only these bookmaker or exchange keys"),
        markets: keys(20).optional().describe("Only these market keys, such as h2h"),
        region,
        limit: limit("bookmakers", 10),
        max_tokens: maxTokens,
      },
      annotations: SPENDS,
    },
    (a) =>
      run(async (c) => {
        const res = await c.event(a.id, { region: a.region }, { maxTokens: a.max_tokens });
        const event = body(res);
        // The route takes no venue or market filter, so the reply is narrowed here; that does not change the cost.
        const books = event.bookmakers
          .filter((b) => !a.bookmakers || a.bookmakers.includes(b.key))
          .map((b) => (a.markets ? { ...b, markets: b.markets.filter((m) => a.markets?.includes(m.key)) } : b));
        return { ...event, ...trim(books, a.limit, "bookmakers"), tokens: spent(res.tokens) };
      }),
  );

  server.registerTool(
    "usage",
    {
      title: "Usage",
      description: "Shows this key's plan, token balance, reset time and scope. Costs no tokens.",
      annotations: READ_ONLY,
    },
    () => run(async (c) => body(await c.usage())),
  );

  return server;
}

/** The reply's data. The server's clients send no ETag, so a 304 cannot happen; this only narrows the type. */
function body<T>(res: Result<T>): T {
  if (res.notModified) throw new Error("unexpected 304 Not Modified");
  return res.data;
}

/** How many of the first `limit` rows fit in REPLY_BUDGET characters: always at least one when there are any. */
function fit(rows: unknown[], limit: number): number {
  let n = 0;
  for (let size = 0; n < Math.min(limit, rows.length); n++) {
    size += JSON.stringify(rows[n]).length;
    if (n > 0 && size > REPLY_BUDGET) break;
  }
  return n;
}

/** The rows that fit, and a note counting the rest. */
function trim<T>(rows: T[], limit: number, noun: string): Record<string, unknown> {
  const n = fit(rows, limit);
  if (n === rows.length) return { [noun]: rows };
  const why = n < limit ? ", to keep the reply short: narrow the filters" : ": raise limit (up to 100) or narrow the filters";
  return { [noun]: rows.slice(0, n), more: `${rows.length - n} more ${noun} not shown${why}` };
}

interface At {
  /** Rows of the API page already shown. */
  skip: number;
  /** The API's own cursor for that page; none on the first page. */
  api: string | undefined;
}

/** Our cursor is "<skip>:<the API's cursor>", so a page cut short resumes at its first row not shown. */
function unpack(cursor: string | undefined): At {
  const m = cursor?.match(/^(\d+):(.*)$/);
  return m ? { skip: Number(m[1]), api: m[2] || undefined } : { skip: 0, api: cursor };
}

/** One API page from row `skip`, cut to fit. next_cursor goes on from the first row not shown. */
function page<T>(p: Page<T>, at: At, limit: number, noun: string): Record<string, unknown> {
  const rows = p.data.slice(at.skip);
  const n = fit(rows, limit);
  if (n === rows.length) return { [noun]: rows, ...(p.meta.next_cursor ? { next_cursor: p.meta.next_cursor } : {}) };
  const more = `${rows.length - n} more ${noun} on this page not shown: pass next_cursor back as cursor`;
  return { [noun]: rows.slice(0, n), more, next_cursor: `${at.skip + n}:${at.api ?? ""}` };
}

function spent(t: Tokens) {
  return { cost: t.cost, remaining: t.remaining };
}

function explain(err: unknown): Record<string, unknown> {
  if (err instanceof OverBudgetError) {
    return {
      error: "over_max_tokens",
      message:
        `This call is priced at ${err.quote.cost} tokens, above max_tokens ${err.maxTokens}, so it was not made and ` +
        "nothing was spent. Narrow the filters, or ask the user before calling again with a higher max_tokens.",
      cost: err.quote.cost,
      max_tokens: err.maxTokens,
      remaining: err.quote.remaining,
    };
  }
  if (err instanceof InsufficientTokensError) {
    const { code, message, cost, remaining, resetsAt, requestId } = err;
    return { error: code, message, cost, remaining, resets_at: resetsAt, request_id: requestId };
  }
  if (err instanceof OddsRelayError) {
    const { code, status, message, body, requestId } = err;
    return { error: code, status, message, valid: body?.valid, request_id: requestId };
  }
  return { error: "client_error", message: err instanceof Error ? err.message : String(err) };
}
