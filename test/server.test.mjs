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

test("lists the seven read-only tools, with max_tokens on the two that spend", async () => {
  const client = await connect(stub(() => [500, {}]).fetch);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["bookmakers", "coverage", "event_odds", "events", "odds", "sports", "usage"]);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, t.name);
    const spends = t.name === "odds" || t.name === "event_odds";
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
  assert.match(odds.body.more, /^7 more events not shown/);
  assert.equal(odds.body.meta.count, 12);

  const all = await call(client, "odds", oddsArgs);
  assert.equal(all.body.events.length, 10, "default limit");

  const sports = await call(client, "sports", { limit: 1 });
  assert.equal(sports.body.sports.length, 1);
  assert.match(sports.body.more, /^1 more sports not shown/);
  assert.equal(sports.body.next_cursor, fixture("v2-sports.page.json").meta.next_cursor);
});

test("event_odds narrows the reply to the named bookmakers and markets", async () => {
  const { fetch } = stub((u) => (u.searchParams.get("quote") === "true" ? quote(10) : [200, rawEvent]));
  const res = await call(await connect(fetch), "event_odds", { id: "or_evt_1", bookmakers: ["betfred", "betfair_exchange"], markets: ["h2h"], limit: 1 });
  assert.deepEqual(res.body.bookmakers.map((b) => b.key), ["betfred"]);
  assert.deepEqual(res.body.bookmakers[0].markets.map((m) => m.key), ["h2h"]);
  assert.match(res.body.more, /^1 more bookmakers/);
});

test("coverage reads both shapes as flat rows, filtered", async () => {
  const keyless = fixture("v2-coverage.keyless.json");
  const { fetch, calls } = stub(() => [200, keyless]);
  const res = await call(await connect(fetch, null), "coverage", { product: "dutching", bookmaker: "7bet" });
  assert.equal(calls[0].headers.Authorization, undefined, "no key, no header");
  assert.deepEqual(res.body.rows, keyless.products.dutching.filter((r) => r.bookmaker === "7bet"));
  assert.deepEqual(res.body.markets, keyless.markets.dutching);

  const keyed = fixture("v2-coverage.keyed.json");
  const withKey = await call(await connect(stub(() => [200, keyed]).fetch), "coverage", { product: "2up", sport: "soccer" });
  assert.deepEqual(withKey.body.rows.map((r) => [r.bookmaker, r.events]), [
    ["betmgm", keyed.products["2up"].bookmakers[0].sports.soccer.events],
    ["betdaq", keyed.products["2up"].exchanges[0].sports.soccer.events],
  ]);

  const unknown = await call(await connect(stub(() => [200, keyed]).fetch), "coverage", { product: "nope" });
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
