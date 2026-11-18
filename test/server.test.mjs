// Runs against the built server (npm test builds first). No network: every request goes to a stubbed fetch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VERSION, createServer } from "../dist/server.js";

const KEY = "or_live_test_key_that_must_never_show";
const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const fixture = (name) => read(`fixtures/${name}`);

/** A fetch stub: `route(url)` returns [status, body, headers?]; every request is recorded. */
function stub(route) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, headers: init.headers });
    const [status, body, headers = {}] = route(u);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  };
  return { fetch, calls };
}

/** `key` null means no ODDSRELAY_KEY at all. */
async function connect(fetch, key = KEY) {
  if (key === null) delete process.env.ODDSRELAY_KEY;
  else process.env.ODDSRELAY_KEY = key;
  const server = createServer({ fetch });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  return { text, body: JSON.parse(text), isError: res.isError === true };
}

const quote = (cost) => [200, { cost, remaining: 100000, rate_card: "test" }];
const spent = { "x-tokens-cost": "12", "x-tokens-remaining": "988" };

function board(n) {
  const event = (i) => ({
    event_id: `or_evt_${i}`,
    sport_key: "soccer_test",
    sport_title: "Test League",
    commence_time: "2026-10-10T14:00:00Z",
    home_team: `Home ${i}`,
    away_team: `Away ${i}`,
    markets: [{ key: "h2h", outcomes: [{ name: `Home ${i}`, back: [{ bookmaker: "ladbrokes", price: 2.1, link: null }], lay: [{ exchange: "betfair_exchange", price: 2.2, available: 50, link: null }] }] }],
  });
  const meta = { feed_type: "standard", region: "uk", odds_format: "decimal", processed_at: "2026-10-09T00:00:00Z", count: n, version: "v2", next_cursor: null };
  return { meta, data: Array.from({ length: n }, (_, i) => event(i)) };
}

/** A board whose events are each longer than one reply's budget. */
function wideBoard(n) {
  const b = board(n);
  for (const e of b.data) e.markets[0].outcomes[0].name = "x".repeat(35000);
  return b;
}

const rawEvent = {
  id: "or_evt_1",
  cluster_id: null,
  sport_key: "soccer_test",
  sport_title: "Test League",
  commence_time: "2026-10-10T14:00:00Z",
  home_team: "Home",
  away_team: "Away",
  bookmakers: ["ladbrokes", "betfred", "betfair_exchange"].map((key) => ({
    key,
    title: key,
    region: "uk",
    last_update: null,
    markets: [
      { key: "h2h", last_update: null, outcomes: [{ name: "Home", price: 2 }] },
      { key: "totals", last_update: null, outcomes: [{ name: "Over", price: 1.9 }] },
    ],
  })),
};

const oddsArgs = { type: "standard", sport: "soccer", bookmakers: ["ladbrokes"] };

const SPENDING = ["event_odds", "history", "odds", "raw_odds"];

test("lists the ten tools: max_tokens and no read-only mark on the four that spend", async () => {
  const client = await connect(stub(() => [500, {}]).fetch);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["bookmakers", "coverage", "event_odds", "events", "history", "odds", "raw_odds", "regions", "sports", "usage"]);
  for (const t of tools) {
    const spends = SPENDING.includes(t.name);
    assert.equal(t.annotations?.readOnlyHint, !spends, t.name);
    if (spends) assert.equal(t.annotations?.destructiveHint, false, t.name);
    assert.equal("max_tokens" in (t.inputSchema.properties ?? {}), spends, t.name);
  }
  const odds = tools.find((t) => t.name === "odds");
  assert.deepEqual(odds.inputSchema.required.sort(), ["bookmakers", "sport", "type"]);
  assert.equal(typeof odds.inputSchema.properties.max_tokens.default, "number");
});

test("odds quotes first and refuses above max_tokens without making the call", async () => {
  const { fetch, calls } = stub((u) => (u.searchParams.get("quote") === "true" ? quote(900000) : [200, board(3), spent]));
  const client = await connect(fetch);

  const refused = await call(client, "odds", oddsArgs);
  assert.equal(refused.isError, true);
  assert.equal(refused.body.error, "over_max_tokens");
  assert.equal(refused.body.cost, 900000);
  assert.equal(calls.length, 1, "only the quote was requested");
  assert.equal(calls[0].url.pathname, "/v2/odds/standard");
  assert.equal(calls[0].url.searchParams.get("sports"), "soccer");
  assert.equal(calls[0].url.searchParams.get("bookmakers"), "ladbrokes");
  assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);

  const allowed = await call(client, "odds", { ...oddsArgs, max_tokens: 900000 });
  assert.equal(allowed.isError, false);
  assert.equal(calls.length, 3, "a quote, then the call");
  assert.equal(calls[2].url.searchParams.get("quote"), null);
  assert.deepEqual(allowed.body.tokens, { cost: 12, remaining: 988 });
});

test("event_odds quotes first and refuses above max_tokens", async () => {
  const { fetch, calls } = stub((u) => (u.searchParams.get("quote") === "true" ? quote(900000) : [200, rawEvent]));
  const res = await call(await connect(fetch), "event_odds", { id: "or_evt_1" });
  assert.equal(res.body.error, "over_max_tokens");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/v2/odds/event/or_evt_1");
});

test("trims long replies to limit and says how many more there are", async () => {
  const { fetch } = stub((u) => {
    if (u.pathname === "/v2/sports") return [200, fixture("v2-sports.page.json")];
    return u.searchParams.get("quote") === "true" ? quote(10) : [200, board(12), spent];
  });
  const client = await connect(fetch);

  const odds = await call(client, "odds", { ...oddsArgs, limit: 5 });
  assert.equal(odds.body.events.length, 5);
  assert.match(odds.body.more, /^7 more events not shown: raise limit/);
  assert.equal(odds.body.meta.count, 12);

  const all = await call(client, "odds", oddsArgs);
  assert.equal(all.body.events.length, 10, "default limit");

  // Rows too big to fit: cut for size, never below one row, and the note says to narrow rather than raise limit.
  const wide = await call(await connect(stub((u) => (u.searchParams.get("quote") === "true" ? quote(10) : [200, wideBoard(6)])).fetch), "odds", oddsArgs);
  assert.equal(wide.body.events.length, 1);
  assert.match(wide.body.more, /not shown, to keep the reply short: narrow the filters$/);

  const sports = await call(client, "sports", { limit: 1 });
  assert.equal(sports.body.sports.length, 1);
  assert.match(sports.body.more, /^1 more sports on this page not shown: pass next_cursor/);
  const rest = await call(client, "sports", { limit: 1, cursor: sports.body.next_cursor });
  assert.deepEqual(rest.body.sports, fixture("v2-sports.page.json").data.slice(1));
  assert.equal(rest.body.next_cursor, fixture("v2-sports.page.json").meta.next_cursor, "then the API's own cursor");
});

test("paged tools reach every row when limit cuts a page short", async () => {
  // Two API pages: 250 rows, then 5. Each page is requested with the API's cursor, never ours.
  const rows = (prefix, n) => Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}` }));
  const pages = { "": { data: rows("a", 250), next: "P2" }, P2: { data: rows("b", 5), next: null } };
  for (const [name, args, noun] of [["sports", {}, "sports"], ["events", { sport: "soccer" }, "events"]]) {
    const { fetch, calls } = stub((u) => {
      const p = pages[u.searchParams.get("cursor") ?? ""];
      return [200, { meta: { next_cursor: p.next }, data: p.data }];
    });
    const client = await connect(fetch);
    const seen = [];
    let cursor;
    for (let i = 0; i < 10 && (i === 0 || cursor); i++) {
      const { body } = await call(client, name, { ...args, limit: 100, ...(cursor ? { cursor } : {}) });
      seen.push(...body[noun].map((r) => r.key));
      cursor = body.next_cursor;
    }
    assert.deepEqual(seen, [...rows("a", 250), ...rows("b", 5)].map((r) => r.key), name);
    assert.deepEqual(calls.map((c) => c.url.searchParams.get("cursor")), [null, null, null, "P2"], name);
  }
});

/** A raw board page of n events, as the raw route and the history routes send one. */
function rawBoard(n, next = null, region = "us") {
  const meta = { feed_type: "raw", region, odds_format: "decimal", processed_at: "2026-11-18T00:00:00Z", count: n, version: "v2", next_cursor: next, total: n, board_version: 1 };
  return { meta, data: Array.from({ length: n }, (_, i) => ({ ...rawEvent, id: `or_evt_${i}` })) };
}

test("every tool's description says which regions it serves", async () => {
  const { tools } = await (await connect(stub(() => [500, {}]).fetch)).listTools();
  for (const t of tools) assert.match(t.description, /region/, t.name);
  const about = Object.fromEntries(tools.map((t) => [t.name, t.description]));
  for (const name of ["sports", "events", "bookmakers", "raw_odds", "event_odds", "history"]) assert.match(about[name], /every region/, name);
  for (const name of ["odds", "coverage", "regions", "bookmakers"]) assert.match(about[name], /UK & Ireland/, name);
  assert.match(about.odds, /product_not_in_region/);
});

test("raw_odds sends a region list, the filters and in-play as the API names them, quoting first", async () => {
  const { fetch, calls } = stub((u) => (u.searchParams.get("quote") === "true" ? quote(40) : [200, rawBoard(3, "P2"), spent]));
  const client = await connect(fetch);
  const res = await call(client, "raw_odds", { sport: "basketball", region: "us,global", bookmakers: ["fanduel"], markets: ["h2h"], in_play: "include", limit: 3 });
  assert.equal(res.isError, false);
  assert.equal(calls.length, 2, "a quote, then the call");
  assert.match(calls[0].url.search, /region=us,global/, "the list goes as one region parameter");
  for (const c of calls) {
    assert.equal(c.url.pathname, "/v2/odds/raw");
    const q = c.url.searchParams;
    assert.deepEqual(
      [q.get("region"), q.get("sports"), q.get("bookmakers"), q.get("markets"), q.get("inPlay"), q.get("limit")],
      ["us,global", "basketball", "fanduel", "h2h", "include", "3"],
    );
  }
  assert.equal(res.body.events.length, 3);
  assert.equal(res.body.next_cursor, "P2");
  assert.equal("next_cursor" in res.body.meta, false);
  assert.deepEqual(res.body.tokens, { cost: 12, remaining: 988 });

  await call(client, "raw_odds", { sport: "basketball", region: "us", cursor: "P2" });
  assert.equal(calls.at(-1).url.searchParams.get("cursor"), "P2");

  const dear = stub((u) => (u.searchParams.get("quote") === "true" ? quote(900000) : [200, rawBoard(1)]));
  const refused = await call(await connect(dear.fetch), "raw_odds", { sport: "soccer", region: "za" });
  assert.equal(refused.body.error, "over_max_tokens");
  assert.equal(dear.calls.length, 1, "only the quote was requested");
});

test("raw_odds refuses a region that is not lowercase codes joined by commas, before any request", async () => {
  const { fetch, calls } = stub(() => [200, rawBoard(1)]);
  const client = await connect(fetch);
  for (const region of ["US", "us, global", "us,", ""]) {
    const res = await client.callTool({ name: "raw_odds", arguments: { sport: "soccer", region } }).catch(() => ({ isError: true }));
    assert.equal(res.isError, true, JSON.stringify(region));
  }
  assert.equal(calls.length, 0);
});

test("history reads the snapshot and closing routes for one region, quoting first", async () => {
  const { fetch, calls } = stub((u) => (u.searchParams.get("quote") === "true" ? quote(40) : [200, rawBoard(2, "N2"), spent]));
  const client = await connect(fetch);

  const snap = await call(client, "history", { kind: "snapshot", date: "2026-11-17T12:00:00Z", sport: "soccer", region: "us", bookmakers: ["fanduel"], bookmakers_only: true });
  assert.equal(snap.isError, false);
  assert.deepEqual(calls.map((c) => [c.url.pathname, c.url.searchParams.get("quote")]), [["/v2/historical/odds/raw", "true"], ["/v2/historical/odds/raw", null]]);
  const q = calls[1].url.searchParams;
  assert.deepEqual(
    [q.get("date"), q.get("sports"), q.get("region"), q.get("bookmakers"), q.get("bookmakersOnly")],
    ["2026-11-17T12:00:00Z", "soccer", "us", "fanduel", "true"],
  );
  assert.equal(calls[1].headers.Authorization, `Bearer ${KEY}`);
  assert.equal(snap.body.events.length, 2);
  assert.equal(snap.body.next_cursor, "N2");
  assert.deepEqual(snap.body.tokens, { cost: 12, remaining: 988 });

  await call(client, "history", { kind: "closing", date: "2026-11-17", sport: "soccer", limit: 100, cursor: "N2" });
  const last = calls.at(-1).url;
  assert.equal(last.pathname, "/v2/historical/closing");
  assert.deepEqual([last.searchParams.get("date"), last.searchParams.get("limit"), last.searchParams.get("cursor")], ["2026-11-17", "50", "N2"]);
  assert.equal(last.searchParams.get("region"), null, "left out, the API picks the region");
});

test("history passes on the archive's earliest date when a date is before it, and its cap refuses a dear call", async () => {
  const early = { error: { code: "date_out_of_range", message: "before the archive", earliest: "2026-11-16T00:00:00.000Z" } };
  const res = await call(await connect(stub(() => [400, early]).fetch), "history", { kind: "snapshot", date: "2026-11-01T00:00:00Z", sport: "soccer", region: "us" });
  assert.equal(res.isError, true);
  assert.deepEqual([res.body.error, res.body.earliest], ["date_out_of_range", "2026-11-16T00:00:00.000Z"]);

  const dear = stub((u) => (u.searchParams.get("quote") === "true" ? quote(900000) : [200, rawBoard(1)]));
  const refused = await call(await connect(dear.fetch), "history", { kind: "closing", date: "2026-11-17", sport: "soccer" });
  assert.equal(refused.body.error, "over_max_tokens");
  assert.equal(dear.calls.length, 1);
});

test("a priced page cut for size goes on from its first event not shown, and says that call is priced again", async () => {
  const wide = rawBoard(3, "P2");
  wide.data.forEach((e, i) => (e.home_team = `${i}`.padEnd(20000, "x")));
  const { fetch, calls } = stub((u) => (u.searchParams.get("quote") === "true" ? quote(10) : [200, wide]));
  const client = await connect(fetch);
  const first = await call(client, "raw_odds", { sport: "soccer", region: "us", limit: 3 });
  assert.equal(first.body.events.length, 1);
  assert.match(first.body.more, /^2 more events on this page not shown: pass next_cursor back as cursor \(that call is priced again\)/);
  const next = await call(client, "raw_odds", { sport: "soccer", region: "us", limit: 3, cursor: first.body.next_cursor });
  assert.equal(calls.at(-1).url.searchParams.get("cursor"), null, "the same API page");
  assert.equal(next.body.events[0].id, "or_evt_1");
});

test("bookmakers and event_odds pass the region on, event_odds in-play too, and regions lists the key's codes", async () => {
  const regions = { version: "v2", default_region: "uk", regions: [{ code: "uk" }, { code: "us" }] };
  const { fetch, calls } = stub((u) => {
    if (u.pathname === "/v2/regions") return [200, regions];
    if (u.pathname === "/v2/bookmakers") return [200, { meta: {}, data: [{ key: "fanduel" }] }];
    return u.searchParams.get("quote") === "true" ? quote(10) : [200, rawEvent];
  });
  const client = await connect(fetch);
  assert.deepEqual((await call(client, "bookmakers", { region: "us" })).body.venues, [{ key: "fanduel" }]);
  assert.equal(calls.at(-1).url.searchParams.get("region"), "us");
  await call(client, "event_odds", { id: "or_evt_1", region: "us", in_play: "include" });
  assert.deepEqual([calls.at(-1).url.searchParams.get("region"), calls.at(-1).url.searchParams.get("inPlay")], ["us", "include"]);
  assert.deepEqual((await call(client, "regions")).body, regions);
});

test("event_odds narrows the reply to the named bookmakers and markets", async () => {
  const { fetch } = stub((u) => (u.searchParams.get("quote") === "true" ? quote(10) : [200, rawEvent]));
  const res = await call(await connect(fetch), "event_odds", { id: "or_evt_1", bookmakers: ["betfred", "betfair_exchange"], markets: ["h2h"], limit: 1 });
  assert.deepEqual(res.body.bookmakers.map((b) => b.key), ["betfred"]);
  assert.deepEqual(res.body.bookmakers[0].markets.map((m) => m.key), ["h2h"]);
  assert.match(res.body.more, /^1 more bookmakers/);
});

test("coverage reads one product as flat rows with its market keys, never sending the key", async () => {
  const keyless = fixture("v2-coverage.keyless.json");
  for (const key of [null, KEY]) {
    const { fetch, calls } = stub(() => [200, keyless]);
    const res = await call(await connect(fetch, key), "coverage", { product: "dutching", bookmaker: "7bet" });
    assert.equal(calls[0].headers.Authorization, undefined, "no header, key set or not");
    assert.deepEqual(res.body.rows, keyless.products.dutching.filter((r) => r.bookmaker === "7bet"));
    assert.deepEqual(res.body.markets, keyless.markets.dutching);
  }

  const unknown = await call(await connect(stub(() => [200, keyless]).fetch), "coverage", { product: "nope" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.body.message, /products: /);
});

test("API errors come back as tool errors with the code and the valid values", async () => {
  const { fetch } = stub((u) => (u.searchParams.get("quote") === "true" ? [400, fixture("error-400.unknown_bookmaker.json")] : [500, {}]));
  const res = await call(await connect(fetch), "odds", { ...oddsArgs, bookmakers: ["nope"] });
  assert.equal(res.isError, true);
  assert.equal(res.body.error, "unknown_bookmaker");
  assert.ok(res.body.valid.includes("bet365"));
});

test("a 402 keeps the cost, the balance and when it renews", async () => {
  const short = { error: { code: "insufficient_tokens", message: "not enough tokens", cost: 12, remaining: 3, resets_at: "2026-11-01T00:00:00Z", request_id: "or_req_1" } };
  const { fetch } = stub((u) => (u.searchParams.get("quote") === "true" ? quote(12) : [402, short]));
  const res = await call(await connect(fetch), "odds", oddsArgs);
  assert.equal(res.isError, true);
  assert.deepEqual(
    [res.body.error, res.body.cost, res.body.remaining, res.body.resets_at, res.body.request_id],
    ["insufficient_tokens", 12, 3, "2026-11-01T00:00:00Z", "or_req_1"],
  );
});

test("the key never appears in any tool output or error", async () => {
  // A server that echoes the key everywhere: in error messages, in valid lists and in data.
  const echo = (u) => {
    if (u.pathname === "/v2/usage") return [200, { plan: KEY, key: { id: KEY } }];
    return [400, { error: { code: "bad_request", message: `echo ${KEY}`, request_id: KEY, valid: [KEY] } }];
  };
  const calls = [
    ["sports", {}],
    ["events", { sport: "soccer" }],
    ["bookmakers", {}],
    ["coverage", {}],
    ["odds", oddsArgs],
    ["event_odds", { id: "or_evt_1" }],
    ["raw_odds", { sport: "soccer", region: "us,global" }],
    ["history", { kind: "closing", date: "2026-11-16", sport: "soccer", region: "us" }],
    ["regions", {}],
    ["usage", {}],
  ];
  const client = await connect(stub(echo).fetch);
  for (const [name, args] of calls) {
    const { text } = await call(client, name, args);
    assert.ok(!text.includes(KEY), `${name} leaked the key: ${text}`);
    assert.ok(text.includes("[hidden]"), `${name} reached the echo`);
  }

  // A key with a quote mark reaches the reply text JSON-escaped; that form is hidden too.
  const quoted = `${KEY}"x`;
  const echoQuoted = (u) => [400, { error: { code: "bad_request", message: `echo ${quoted}` } }];
  const escaped = await call(await connect(stub(echoQuoted).fetch, quoted), "usage");
  assert.ok(!escaped.text.includes(JSON.stringify(quoted).slice(1, -1)), escaped.text);
  assert.ok(!escaped.body.message.includes(quoted), escaped.text);

  // A key a header cannot carry is refused by the client before any request, without echoing it.
  const bad = `${KEY}\nsecond_line`;
  const refused = await call(await connect(stub(echo).fetch, bad), "usage");
  assert.equal(refused.isError, true);
  assert.ok(!refused.text.includes("second_line"), refused.text);
});

test("a missing key is explained before any request is made", async () => {
  const { fetch, calls } = stub(() => [500, {}]);
  const res = await call(await connect(fetch, null), "odds", oddsArgs);
  assert.equal(res.body.error, "missing_key");
  assert.equal(calls.length, 0);
});

test("package.json, server.json and the server agree on name and version", () => {
  const pkg = read("../package.json");
  const reg = read("../server.json");
  assert.equal(VERSION, pkg.version);
  assert.equal(reg.version, pkg.version);
  assert.equal(reg.name, pkg.mcpName);
  const [npm] = reg.packages;
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version);
  assert.equal(npm.transport.type, "stdio");
  assert.deepEqual(
    npm.environmentVariables.map((v) => [v.name, v.isSecret]),
    [["ODDSRELAY_KEY", true]],
  );
});

test("the MCPB manifest matches package.json and the server's tools, and hands the key over as ODDSRELAY_KEY", async () => {
  const pkg = read("../package.json");
  const mcpb = read("../manifest.json");
  assert.equal(mcpb.version, pkg.version);
  assert.equal(mcpb.server.entry_point, pkg.bin["oddsrelay-mcp"]);
  const { tools } = await (await connect(stub(() => [500, {}]).fetch)).listTools();
  assert.deepEqual(mcpb.tools.map((t) => t.name).sort(), tools.map((t) => t.name).sort());
  assert.equal(mcpb.server.mcp_config.env.ODDSRELAY_KEY, "${user_config.api_key}");
  assert.equal(mcpb.user_config.api_key.sensitive, true);
  assert.equal(mcpb.user_config.api_key.required, true);
});

test("the Gemini CLI manifest matches package.json and asks for the key as ODDSRELAY_KEY, by name only", () => {
  const pkg = read("../package.json");
  const gem = read("../gemini-extension.json");
  assert.equal(gem.version, pkg.version);
  assert.deepEqual(gem.mcpServers, { oddsrelay: { command: "npx", args: ["-y", pkg.name] } });
  assert.deepEqual(gem.settings.map((s) => [s.envVar, s.sensitive]), [["ODDSRELAY_KEY", true]]);
});

test("CHANGELOG.md has an entry for package.json's version, which the release notes are made from", () => {
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  assert.ok(changelog.split("\n").some((l) => l.startsWith(`## ${read("../package.json").version} `)));
});

test("every devDependency is kept out of the bundle by .mcpbignore", () => {
  const ignored = readFileSync(new URL("../.mcpbignore", import.meta.url), "utf8").split("\n").map((l) => l.trim());
  for (const dep of Object.keys(read("../package.json").devDependencies)) {
    const scope = dep.split("/")[0];
    assert.ok(ignored.includes(`node_modules/${dep}`) || ignored.includes(`node_modules/${scope}`), dep);
  }
});
