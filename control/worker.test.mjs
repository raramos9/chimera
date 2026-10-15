import assert from "node:assert/strict";
import fs from "node:fs";
import { register } from "node:module";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const hook = `
import fs from "node:fs";
import { fileURLToPath } from "node:url";
export async function resolve(specifier, context, nextResolve) {
  if (specifier !== "cloudflare:workers") return nextResolve(specifier, context);
  return { url: "stub:cloudflare-workers", shortCircuit: true };
}
export async function load(url, context, nextLoad) {
  if (url === "stub:cloudflare-workers") {
    const source = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }";
    return { format: "module", shortCircuit: true, source };
  }
  if (!url.endsWith(".yaml") && !url.endsWith(".html")) return nextLoad(url, context);
  const text = fs.readFileSync(fileURLToPath(url), "utf8");
  return { format: "module", shortCircuit: true, source: "export default " + JSON.stringify(text) };
}
`;
register("data:text/javascript," + encodeURIComponent(hook));

const calls = [];
let list = () => new Response(JSON.stringify({ servers: [] }));
let actionPolls = 0;
const allVolumes = [{ id: 107072286, name: "chimera-home" }, { id: 107108017, name: "chimera-machines" }];
let volumes = allVolumes;
const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();
const image = (id, ageDays, extra = {}) =>
  ({ id, status: "available", created: daysAgo(ageDays), labels: { chimera: "base" }, created_from: { id: 1 }, ...extra });
const freshImages = [image(555, 1), image(444, 8)];
let images = freshImages;
let builds = [];

globalThis.fetch = async (url, init) => {
  const { pathname, searchParams } = new URL(url);
  calls.push({ url, method: init.method, headers: init.headers, body: init.body });
  if (init.method === "PUT") return new Response(JSON.stringify({ image: {} }));
  if (init.method === "DELETE") return new Response(JSON.stringify({ action: { id: 7, status: "running" } }));
  if (init.method === "POST") return new Response(JSON.stringify({ server: { id: 1 } }));
  if (pathname === "/v1/volumes") return new Response(JSON.stringify({ volumes: volumes.filter((v) => v.name === searchParams.get("name")) }));
  if (pathname === "/v1/images") {
    const status = searchParams.get("status");
    return new Response(JSON.stringify({ images: images.filter((i) => !status || i.status === status) }));
  }
  if (searchParams.get("name") === "chimera-image-build") return new Response(JSON.stringify({ servers: builds }));
  if (pathname === "/v1/actions/7") {
    return new Response(JSON.stringify({ action: { id: 7, status: actionPolls++ === 0 ? "running" : "success" } }));
  }
  return list();
};

const { default: worker, Records } = await import("./worker.js");

const storage = new Map();
const sockets = [];
let autoResponse = null;
const records = new Records(
  {
    storage: { get: async (key) => storage.get(key), put: async (key, value) => void storage.set(key, structuredClone(value)) },
    getWebSockets: () => sockets,
    acceptWebSocket: (socket) => sockets.push(socket),
    setWebSocketAutoResponse: (pair) => { autoResponse = pair; },
  },
  {},
);
const RECORDS = { idFromName: (id) => id, get: () => records };
const testEnv = (extra = {}) =>
  ({ HCLOUD_TOKEN: "t", MAX_AWAKE_MINUTES: "1440", WAKE_TOKEN: "pw", AGENT_TOKEN: "agent", RECORDS, ...extra });

const unpackUserData = (packed) => {
  const [, base64] = packed.match(/^Content-Transfer-Encoding: base64\n\n(\S+)\n--chimera--\n$/m);
  return gunzipSync(Buffer.from(base64, "base64")).toString("utf8");
};

async function run(label, servers, check) {
  calls.length = 0;
  list = () => new Response(JSON.stringify({ servers }));
  await worker.scheduled({}, testEnv());
  check();
  console.log(`PASS: ${label}`);
}

const deletes = () => calls.filter((c) => c.method === "DELETE");
const posts = () => calls.filter((c) => c.method === "POST");
const server = (status, minutesAgo) =>
  ({ id: 42, name: "chimera", status, created: new Date(Date.now() - minutesAgo * 60000).toISOString() });

await run("powered-off server is deleted", [server("off", 60)], () => {
  assert.equal(calls[0].url, "https://api.hetzner.cloud/v1/servers?name=chimera");
  assert.equal(deletes().length, 1);
  assert.equal(deletes()[0].url, "https://api.hetzner.cloud/v1/servers/42");
  for (const c of calls) assert.equal(c.headers.Authorization, "Bearer t");
});

await run("running server is left alone", [server("running", 60)], () => {
  assert.equal(deletes().length, 0);
  assert.equal(posts().length, 0);
});

await run("server off within 5 minutes of creation is left alone", [server("off", 2)], () => {
  assert.equal(deletes().length, 0);
});

await run("server awake 24 hours is shut down", [server("running", 1441)], () => {
  assert.equal(deletes().length, 0);
  assert.deepEqual(posts().map((c) => c.url), ["https://api.hetzner.cloud/v1/servers/42/actions/shutdown"]);
});

await run("server still awake 15 minutes after the limit is forced off", [server("running", 1456)], () => {
  assert.deepEqual(posts().map((c) => c.url), ["https://api.hetzner.cloud/v1/servers/42/actions/poweroff"]);
});

await run("server stuck starting past the limit is forced off", [server("starting", 1456)], () => {
  assert.deepEqual(posts().map((c) => c.url), ["https://api.hetzner.cloud/v1/servers/42/actions/poweroff"]);
});

await run("server stuck starting before the force-off point is left alone", [server("starting", 1441)], () => {
  assert.equal(posts().length, 0);
});

await run("server that went off past the limit is deleted", [server("off", 1456)], () => {
  assert.equal(deletes().length, 1);
  assert.equal(posts().length, 0);
});

await run("server already deleting is left alone", [server("deleting", 1500)], () => {
  assert.equal(deletes().length, 0);
  assert.equal(posts().length, 0);
});

await run("no server is a no-op", [], () => {
  assert.equal(deletes().length, 0);
});

calls.length = 0;
list = () => new Response("unauthorized", { status: 401 });
await assert.rejects(
  worker.scheduled({}, { HCLOUD_TOKEN: "t", MAX_AWAKE_MINUTES: "1440" }),
  /GET \/servers\?name=chimera: 401 unauthorized/,
);
assert.equal(deletes().length, 0);
console.log("PASS: list failure rejects");

calls.length = 0;
await assert.rejects(worker.scheduled({}, { HCLOUD_TOKEN: "t" }), /MAX_AWAKE_MINUTES must be a positive number/);
assert.equal(calls.length, 0);
console.log("PASS: missing limit rejects");

const wake = (token, { method = "POST", path = "/wake", header = `Bearer ${token}` } = {}) =>
  worker.fetch(
    new Request(`https://control.example${path}`, { method, headers: header ? { Authorization: header } : {} }),
    testEnv({ WAKE_TOKEN: token }),
  );

async function runWake(label, servers, request, check) {
  calls.length = 0;
  actionPolls = 0;
  list = () => new Response(JSON.stringify({ servers }));
  const res = await request();
  await check(res);
  console.log(`PASS: ${label}`);
}

await runWake("GET /wake is not found", [], () => wake("pw", { method: "GET" }), async (res) => {
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
});

await runWake("POST /other is not found", [], () => wake("pw", { path: "/other" }), async (res) => {
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
});

await runWake("missing password is refused", [], () => wake("pw", { header: null }), async (res) => {
  assert.equal(res.status, 401);
  assert.equal(await res.text(), "Wrong password.");
  assert.equal(calls.length, 0);
});

await runWake("wrong password is refused", [], () => wake("pw", { header: "Bearer nope" }), async (res) => {
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

await runWake("unset secret does not accept 'Bearer undefined'", [], () => wake(undefined), async (res) => {
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

await runWake("asleep computer is created", [], () => wake("pw"), async (res) => {
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "Waking up. Ready in about 30 seconds.");
  assert.equal(posts().length, 1);
  assert.ok(calls.some((c) => c.url === "https://api.hetzner.cloud/v1/volumes?name=chimera-home"));
  assert.ok(calls.some((c) => c.url === "https://api.hetzner.cloud/v1/volumes?name=chimera-machines"));
  assert.ok(calls.some((c) => c.url === "https://api.hetzner.cloud/v1/images?type=snapshot&status=available&label_selector=chimera%3Dbase&sort=created:desc"));
  assert.equal(posts()[0].url, "https://api.hetzner.cloud/v1/servers");
  assert.equal(posts()[0].headers["Content-Type"], "application/json");
  const body = JSON.parse(posts()[0].body);
  assert.deepEqual(body, {
    name: "chimera",
    server_type: "cpx11",
    image: 555,
    location: "hil",
    ssh_keys: ["laptop"],
    volumes: [107072286, 107108017],
    automount: false,
    public_net: { enable_ipv4: true, enable_ipv6: true, ipv4: 154132581 },
    firewalls: [{ firewall: 11770509 }],
    user_data: body.user_data,
  });
  assert.ok(body.user_data.length <= 32 * 1024, `user data is ${body.user_data.length} bytes, over Hetzner's 32 KiB limit`);
  assert.equal(unpackUserData(body.user_data), fs.readFileSync(fileURLToPath(new URL("../cloud-init.yaml", import.meta.url)), "utf8"));
});

await runWake("running computer is left alone", [{ id: 42, name: "chimera", status: "running" }], () => wake("pw"), async (res) => {
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "Already awake.");
  assert.equal(posts().length, 0);
});

await runWake("starting computer is left alone", [{ id: 42, name: "chimera", status: "starting" }], () => wake("pw"), async (res) => {
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "Already waking up.");
  assert.equal(posts().length, 0);
});

await runWake("stopping computer is busy", [{ id: 42, name: "chimera", status: "stopping" }], () => wake("pw"), async (res) => {
  assert.equal(res.status, 409);
  assert.equal(await res.text(), "Going to sleep. Try again in a minute.");
  assert.equal(posts().length, 0);
});

await runWake("unknown status is busy", [{ id: 42, name: "chimera", status: "rebuilding" }], () => wake("pw"), async (res) => {
  assert.equal(res.status, 409);
  assert.equal(posts().length, 0);
});

await runWake("powered-off computer is deleted, then created", [{ id: 42, name: "chimera", status: "off" }], () => wake("pw"), async (res) => {
  assert.equal(res.status, 202);
  const steps = calls.slice(1).map((c) => `${c.method} ${new URL(c.url).pathname}`);
  assert.deepEqual(steps, [
    "DELETE /v1/servers/42",
    "GET /v1/actions/7",
    "GET /v1/actions/7",
    "GET /v1/volumes",
    "GET /v1/volumes",
    "GET /v1/images",
    "POST /v1/servers",
  ]);
});

volumes = [];
await runWake("missing volume refuses to create a server", [], () => wake("pw").catch((e) => e), async (err) => {
  assert.match(err.message, /expected one volume named chimera-home, found 0/);
  assert.equal(posts().length, 0);
});

volumes = allVolumes.slice(0, 1);
await runWake("missing machines volume refuses to create a server", [], () => wake("pw").catch((e) => e), async (err) => {
  assert.match(err.message, /expected one volume named chimera-machines, found 0/);
  assert.equal(posts().length, 0);
});

volumes = allVolumes;
images = [];
await runWake("missing image refuses to create a server", [], () => wake("pw").catch((e) => e), async (err) => {
  assert.match(err.message, /no snapshot labeled chimera=base/);
  assert.equal(posts().length, 0);
});

volumes = allVolumes;

async function runBuild(label, buildServers, imageList, check) {
  calls.length = 0;
  builds = buildServers;
  images = imageList;
  list = () => new Response(JSON.stringify({ servers: [] }));
  await worker.scheduled({}, testEnv());
  check();
  console.log(`PASS: ${label}`);
}

const build = (status, minutesAgo) =>
  ({ id: 77, name: "chimera-image-build", status, created: new Date(Date.now() - minutesAgo * 60000).toISOString() });
const writes = () => calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${new URL(c.url).pathname}`);

await runBuild("image under a week old is left alone", [], freshImages, () => {
  assert.deepEqual(writes(), []);
});

await runBuild("image a week old starts a build and marks when", [], [image(555, 7.1), image(444, 20)], () => {
  assert.deepEqual(writes(), ["POST /v1/servers", "PUT /v1/images/555"]);
  const body = JSON.parse(posts()[0].body);
  assert.equal(body.name, "chimera-image-build");
  assert.equal(body.image, "ubuntu-24.04");
  assert.deepEqual(body.firewalls, [{ firewall: 11770509 }]);
  assert.equal(body.volumes, undefined);
  assert.equal(body.user_data, fs.readFileSync(fileURLToPath(new URL("../image.yaml", import.meta.url)), "utf8"));
  const { labels } = JSON.parse(calls.find((c) => c.method === "PUT").body);
  assert.equal(labels.chimera, "base");
  assert.ok(Math.abs(Number(labels.build_started) - Date.now() / 1000) < 60);
});

await runBuild("no image at all starts a build", [], [], () => {
  assert.deepEqual(writes(), ["POST /v1/servers"]);
});

const failedAt = (hoursAgo) => String(Math.floor(Date.now() / 1000 - hoursAgo * 3600));
await runBuild("a build started 2 hours ago is not retried yet", [], [image(555, 8, { labels: { chimera: "base", build_started: failedAt(2) } })], () => {
  assert.deepEqual(writes(), []);
});

await runBuild("a build started a day ago is retried", [], [image(555, 8, { labels: { chimera: "base", build_started: failedAt(25) } })], () => {
  assert.deepEqual(writes(), ["POST /v1/servers", "PUT /v1/images/555"]);
});

await runBuild("a build still installing is left alone", [build("running", 10)], [image(555, 8)], () => {
  assert.deepEqual(writes(), []);
});

await runBuild("a build that never powered off is deleted after an hour", [build("running", 61)], [image(555, 8)], () => {
  assert.deepEqual(writes(), ["DELETE /v1/servers/77"]);
});

await runBuild("a powered-off build is saved as an image", [build("off", 5)], [image(555, 8)], () => {
  assert.deepEqual(writes(), ["POST /v1/servers/77/actions/create_image"]);
  const body = JSON.parse(posts()[0].body);
  assert.equal(body.type, "snapshot");
  assert.deepEqual(body.labels, { chimera: "base" });
});

await runBuild("an image still saving is left alone", [build("off", 8)], [image(600, 0, { status: "creating", created_from: { id: 77 } }), image(555, 8)], () => {
  assert.deepEqual(writes(), []);
});

await runBuild("a saved build is deleted and only two images are kept", [build("off", 12)],
  [image(600, 0, { created_from: { id: 77 } }), image(555, 8), image(444, 15)], () => {
  assert.deepEqual(writes(), ["DELETE /v1/servers/77", "DELETE /v1/images/444"]);
});

builds = [];
images = [image(600, 0, { status: "creating" }), image(555, 8)];
await runWake("waking skips an image that is still saving", [], () => wake("pw"), async () => {
  assert.equal(JSON.parse(posts()[0].body).image, 555);
});

const call = (method, path, { token = "pw", body, env } = {}) =>
  worker.fetch(
    new Request(`https://control.example${path}`, { method, body, headers: token ? { Authorization: `Bearer ${token}` } : {} }),
    testEnv(env),
  );

const workspace = (name, extra = {}) => ({
  name, state: "running", parent: "base", task: null, repo: "o/r", branch: `chimera/${name}`,
  work: { unpushed: [], uncommitted: [], error: null }, ...extra,
});
const sendReport = (workspaces, busy = false) =>
  call("POST", "/report", { token: "agent", body: JSON.stringify({ busy, workspaces }) });
const secondsAgo = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();
const nearNow = (time) => Math.abs(Date.parse(time) - Date.now()) < 5000;

const tokenValues = { WAKE_TOKEN: "pw", AGENT_TOKEN: "agent" };
for (const [method, path, tokenVars] of [
  ["POST", "/wake", ["WAKE_TOKEN"]],
  ["POST", "/want", ["WAKE_TOKEN"]],
  ["GET", "/state", ["WAKE_TOKEN", "AGENT_TOKEN"]],
  ["POST", "/orders", ["WAKE_TOKEN", "AGENT_TOKEN"]],
  ["GET", "/orders", ["AGENT_TOKEN"]],
  ["POST", "/report", ["AGENT_TOKEN"]],
  ["GET", "/agent", ["AGENT_TOKEN"]],
]) {
  storage.clear();
  calls.length = 0;
  const body = method === "POST" ? "awake" : undefined;
  const otherTokens = Object.keys(tokenValues).filter((t) => !tokenVars.includes(t)).map((t) => [`the ${t}`, { token: tokenValues[t] }]);
  const unset = Object.fromEntries(tokenVars.map((t) => [t, undefined]));
  const empty = Object.fromEntries(tokenVars.map((t) => [t, ""]));
  for (const [what, options] of [
    ["wrong token", { token: "nope" }],
    ["missing token", { token: null }],
    ...otherTokens,
    ["unset tokens", { token: "undefined", env: unset }],
    ["empty tokens", { token: "", env: empty }],
  ]) {
    const res = await call(method, path, { body, ...options });
    assert.equal(res.status, 401, `${method} ${path} with ${what}`);
    assert.equal(await res.text(), "Wrong password.");
  }
  assert.equal(storage.size, 0);
  assert.equal(calls.length, 0);
  console.log(`PASS: ${method} ${path} refuses a bad or missing token`);
}

storage.clear();
calls.length = 0;
const secrets = { WAKE_TOKEN: "wake-secret-7q", AGENT_TOKEN: "agent-secret-7q", HCLOUD_TOKEN: "hcloud-secret-7q" };
let res = await call("GET", "/", { token: null, env: secrets });
assert.equal(res.status, 200);
assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
const page = await res.text();
assert.match(page, /^<!doctype html>/i);
for (const secret of Object.values(secrets)) assert.ok(!page.includes(secret));
assert.equal(calls.length, 0);
for (const [method, path] of [["POST", "/"], ["GET", "/nope"], ["GET", "/index.html"]]) {
  assert.equal((await call(method, path, { token: null })).status, 404, `${method} ${path}`);
}
console.log("PASS: GET / serves the page without a token and holds no secrets, other unknown routes still 404");

storage.clear();
res = await sendReport([workspace("a", { work: { unpushed: ["abc1234 add"], uncommitted: [" M a.js"], error: null } })], true);
assert.equal(res.status, 204);
assert.equal(storage.get("computer").busy, true);
assert.ok(nearNow(storage.get("computer").reportedAt));
assert.deepEqual(storage.get("workspaces")[0].work.unpushed, ["abc1234 add"]);
assert.ok(nearNow(storage.get("workspaces")[0].work.checkedAt));
console.log("PASS: a report is stored and stamped with the Worker's clock");

const old = "2020-01-01T00:00:00.000Z";
storage.set("workspaces", [
  workspace("a", { work: { unpushed: ["abc1234 add"], uncommitted: [], error: null, checkedAt: old } }),
  workspace("b"),
  workspace("c", { repo: null, work: null }),
]);
await sendReport([workspace("a", { state: "stopped", work: null }), workspace("c", { state: "stopped", repo: null, work: null })]);
let stored = storage.get("workspaces");
assert.deepEqual(stored.map((w) => w.name), ["a", "c"]);
assert.equal(stored[0].state, "stopped");
assert.deepEqual(stored[0].work, { unpushed: ["abc1234 add"], uncommitted: [], error: null, checkedAt: old });
assert.equal(stored[1].work, null);
console.log("PASS: a stopped container keeps its last check, and containers missing from a report disappear");

await sendReport([workspace("a", { work: { unpushed: [], uncommitted: [], error: "couldn't reach GitHub" } })]);
stored = storage.get("workspaces");
assert.equal(stored[0].work.error, "couldn't reach GitHub");
assert.ok(nearNow(stored[0].work.checkedAt));
console.log("PASS: a fresh check replaces the old one");

storage.clear();
for (const body of [
  "not json",
  "null",
  "{}",
  JSON.stringify({ busy: "yes", workspaces: [] }),
  JSON.stringify({ busy: true, workspaces: {} }),
  JSON.stringify({ busy: true, workspaces: [{ state: "running" }] }),
  JSON.stringify({ busy: true, workspaces: [workspace("a", { task: 5 })] }),
  JSON.stringify({ busy: true, workspaces: [workspace("a", { work: { unpushed: "x", uncommitted: [], error: null } })] }),
  JSON.stringify({ busy: true, workspaces: [workspace("a", { work: undefined })] }),
  JSON.stringify({ busy: true, workspaces: [workspace("a", { agent: "sleeping" })] }),
]) {
  res = await call("POST", "/report", { token: "agent", body });
  assert.equal(res.status, 400, body);
  assert.equal(await res.text(), "Bad report.");
}
assert.equal(storage.size, 0);
console.log("PASS: a malformed report is refused and stores nothing");

for (const agent of [undefined, null, "working", "waiting"]) {
  storage.clear();
  res = await call("POST", "/report", { token: "agent", body: JSON.stringify({ busy: false, workspaces: [workspace("a", { agent })] }) });
  assert.equal(res.status, 204, String(agent));
}
storage.clear();
console.log("PASS: a report may say whether each agent is working or waiting");

const getState = async (servers) => {
  list = () => new Response(JSON.stringify({ servers }));
  return (await call("GET", "/state")).json();
};
const withFirewall = (status, minutesAgo, firewalls = 1) =>
  ({ ...server(status, minutesAgo), public_net: { firewalls: Array.from({ length: firewalls }, () => ({ id: 1 })) } });

storage.clear();
for (const [label, servers, reportedAgo, expected] of [
  ["no server", [], null, "asleep"],
  ["initializing", [server("initializing", 1)], null, "waking"],
  ["starting", [server("starting", 1)], null, "waking"],
  ["running before the first report", [server("running", 5)], 600, "waking"],
  ["running with no report at all", [server("running", 5)], null, "waking"],
  ["running after a report", [server("running", 5)], 60, "awake"],
  ["stopping", [server("stopping", 5)], 60, "going-to-sleep"],
  ["off", [server("off", 5)], 60, "going-to-sleep"],
  ["deleting", [server("deleting", 5)], 60, "going-to-sleep"],
  ["migrating", [server("migrating", 5)], 60, "unknown"],
]) {
  storage.set("computer", { want: null, wantAt: null, busy: null, reportedAt: reportedAgo === null ? null : secondsAgo(reportedAgo) });
  assert.equal((await getState(servers)).state, expected, label);
}
console.log("PASS: /state names the computer's state from Hetzner's status and the last report");

storage.set("computer", { want: "awake", wantAt: secondsAgo(120), busy: false, reportedAt: secondsAgo(40) });
storage.set("workspaces", [
  workspace("a", { work: { unpushed: [], uncommitted: [" M a"], error: null, checkedAt: secondsAgo(100) } }),
  workspace("b", { repo: null, work: null }),
]);
let body = await getState([withFirewall("running", 5, 0)]);
assert.deepEqual(body.server, { status: "running", created: body.server.created, firewalls: 0 });
assert.equal(body.want, "awake");
assert.equal(body.wantAgeSeconds, 120);
assert.equal(body.reportAgeSeconds, 40);
assert.equal(body.busy, false);
assert.equal(body.workspaces[0].work.checkAgeSeconds, 100);
assert.equal(body.workspaces[1].work, null);
body = await getState([]);
assert.equal(body.server, null);
storage.clear();
body = await getState([]);
assert.deepEqual([body.want, body.wantAgeSeconds, body.busy, body.reportAgeSeconds, body.workspaces], [null, null, null, null, []]);
console.log("PASS: /state reports ages in seconds, and nulls before any report");

storage.clear();
await runWake("a wake request records that you want it awake", [], () => wake("pw"), async () => {
  assert.equal(storage.get("computer").want, "awake");
  assert.ok(nearNow(storage.get("computer").wantAt));
});

list = () => new Response(JSON.stringify({ servers: [] }));
calls.length = 0;
res = await call("POST", "/want", { body: "asleep\n" });
assert.equal(res.status, 204);
assert.equal(storage.get("computer").want, "asleep");
assert.equal(posts().length, 0);
console.log("PASS: asleep with no server records the want and shuts nothing down");
list = () => new Response(JSON.stringify({ servers: [{ id: 42, name: "chimera", status: "running", created: secondsAgo(600) }] }));
calls.length = 0;
res = await call("POST", "/want", { body: "asleep" });
assert.equal(res.status, 204);
assert.deepEqual(posts().map((c) => c.url), ["https://api.hetzner.cloud/v1/servers/42/actions/shutdown"]);
console.log("PASS: asleep with a running server asks it to shut down once");
calls.length = 0;
res = await call("POST", "/want", { body: "awake" });
assert.equal(calls.length, 0);
res = await call("POST", "/want", { body: "awake" });
assert.equal(storage.get("computer").want, "awake");
for (const bad of ["", "sleep", "AWAKE", "awake please"]) {
  res = await call("POST", "/want", { body: bad });
  assert.equal(res.status, 400, bad);
}
assert.equal(storage.get("computer").want, "awake");
console.log("PASS: /want sets awake or asleep and refuses anything else");

storage.clear();
await runWake("a wake that is refused records nothing", [{ id: 42, name: "chimera", status: "stopping" }], () => wake("pw"), async (r) => {
  assert.equal(r.status, 409);
  assert.equal(storage.size, 0);
});

for (const [label, servers, expected] of [
  ["no server resets a stale wake request", [], "asleep"],
  ["a powered-off server resets a stale wake request", [server("off", 60)], "asleep"],
  ["a running server keeps the wake request", [server("running", 60)], "awake"],
  ["a starting server keeps the wake request", [server("starting", 1)], "awake"],
]) {
  storage.set("computer", { want: "awake", wantAt: secondsAgo(60), busy: null, reportedAt: null });
  await run(label, servers, () => assert.equal(storage.get("computer").want, expected));
}

storage.clear();
await run("the cron records asleep when nothing was asked yet", [], () => assert.equal(storage.get("computer").want, "asleep"));
storage.set("computer", { ...storage.get("computer"), wantAt: old });
await run("the cron doesn't rewrite a want that is already asleep", [], () => assert.equal(storage.get("computer").wantAt, old));

const order = (body, token = "pw") => call("POST", "/orders", { token, body: JSON.stringify(body) });
const runningServer = [{ id: 42, name: "chimera", status: "running", created: secondsAgo(600) }];
const serverPosts = () => posts().filter((c) => new URL(c.url).pathname === "/v1/servers");
const placeOrder = async (servers, body, token) => {
  calls.length = 0;
  list = () => new Response(JSON.stringify({ servers }));
  const r = await order(body, token);
  return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
};
const resetRecords = (workspaces = []) => {
  storage.clear();
  sockets.length = 0;
  if (workspaces.length) storage.set("workspaces", workspaces);
};
const nudges = () => sockets.flatMap((s) => s.sent);
const fakeSocket = () => ({ sent: [], send(message) { this.sent.push(message); } });

resetRecords();
for (const bad of [
  "not json",
  "null",
  {},
  { action: "make", name: "a" },
  { action: "new" },
  { action: "new", name: "Bad" },
  { action: "new", name: "base" },
  { action: "new", name: "-a" },
  { action: "new", name: "a".repeat(64) },
  { action: "new", name: "a", repo: "no-slash" },
  { action: "new", name: "a", repo: "a/b/c" },
  { action: "new", name: "a", task: 5 },
  { action: "new", name: "a", task: "x".repeat(2001) },
  { action: "rm", name: "a", force: "yes" },
  { action: "fork", name: "a" },
  { action: "fork", name: "a", from: "Bad" },
]) {
  const r = await call("POST", "/orders", { body: typeof bad === "string" ? bad : JSON.stringify(bad) });
  assert.equal(r.status, 400, JSON.stringify(bad));
  assert.equal(await r.text(), "Bad order.");
}
assert.equal(storage.size, 0);
console.log("PASS: a malformed order is refused and stores nothing");

resetRecords();
sockets.push(fakeSocket());
let placed = await placeOrder([], { action: "new", name: "a", task: "do it", repo: "o/r" });
assert.deepEqual(placed.body, { rev: 1, woke: "create" });
assert.equal(serverPosts().length, 1);
let storedOrder = storage.get("orders").a;
assert.deepEqual({ ...storedOrder, orderedAt: undefined },
  { name: "a", want: "running", force: false, from: "base", task: "do it", repo: "o/r", rev: 1, orderedAt: undefined });
assert.ok(nearNow(storedOrder.orderedAt));
assert.equal(storage.get("rev"), 1);
assert.equal(storage.get("computer").want, "awake");
assert.deepEqual(nudges(), ["orders"]);
console.log("PASS: new stores an order from base, wakes a sleeping computer and nudges the computer");

placed = await placeOrder(runningServer, { action: "new", name: "a" });
assert.equal(placed.status, 409);
assert.equal(placed.body, "There's already a container or an order called a.");
resetRecords([workspace("hand")]);
placed = await placeOrder(runningServer, { action: "new", name: "hand" });
assert.equal(placed.status, 409);
assert.equal(storage.get("orders"), undefined);
console.log("PASS: new refuses a name that has an order or a reported container");

resetRecords([workspace("seen")]);
placed = await placeOrder(runningServer, { action: "new", name: "b" }, "agent");
assert.deepEqual(placed.body, { rev: 1, woke: null });
assert.equal(serverPosts().length, 0);
assert.equal(storage.get("orders").b.repo, null);
console.log("PASS: the computer's token can order too, and an awake computer is not woken again");

for (const [label, from, expected] of [
  ["from base", "base", 200],
  ["from a reported container", "seen", 200],
  ["from an ordered container", "b", 200],
  ["from nothing", "ghost", 404],
]) {
  const before = storage.get("rev");
  placed = await placeOrder(runningServer, { action: "fork", name: `f-${from}`, from, task: "try", repo: "o/ignored" });
  assert.equal(placed.status, expected, label);
  if (expected === 200) {
    assert.deepEqual({ ...storage.get("orders")[`f-${from}`], orderedAt: undefined },
      { name: `f-${from}`, want: "running", force: false, from, task: "try", repo: null, rev: before + 1, orderedAt: undefined });
  } else {
    assert.equal(placed.body, "There's no container called ghost.");
    assert.equal(storage.get("rev"), before);
  }
}
placed = await placeOrder(runningServer, { action: "fork", name: "seen", from: "base" });
assert.equal(placed.status, 409);
console.log("PASS: fork needs a parent that exists and a free name, and inherits the repo on the computer");

resetRecords([workspace("seen")]);
storage.set("orders", { going: { name: "going", want: "gone", force: false, from: "base", task: null, repo: null, rev: 3 } });
storage.set("rev", 3);
assert.equal((await placeOrder(runningServer, { action: "fork", name: "x", from: "going" })).status, 404);
storage.set("workspaces", [workspace("seen"), workspace("going")]);
assert.equal((await placeOrder(runningServer, { action: "fork", name: "x", from: "going" })).status, 200);
console.log("PASS: fork refuses a parent that is being deleted unless the computer still reports it");

for (const action of ["start", "stop"]) {
  placed = await placeOrder(runningServer, { action, name: "going" });
  assert.equal(placed.status, 409);
  assert.equal(placed.body, "going is being deleted.");
  placed = await placeOrder(runningServer, { action, name: "ghost" });
  assert.equal(placed.status, 404);
}
console.log("PASS: start and stop refuse an unknown name and one being deleted");

resetRecords([workspace("hand")]);
sockets.push(fakeSocket());
placed = await placeOrder([], { action: "stop", name: "hand" });
assert.deepEqual(placed.body, { rev: 1, woke: null });
assert.equal(calls.length, 0);
assert.deepEqual({ ...storage.get("orders").hand, orderedAt: undefined },
  { name: "hand", want: "stopped", force: false, from: null, task: null, repo: null, rev: 1, orderedAt: undefined });
placed = await placeOrder([], { action: "stop", name: "hand" });
assert.deepEqual(placed.body, { rev: 2, woke: null });
assert.deepEqual(nudges(), ["orders", "orders"]);
console.log("PASS: stop adopts a reported container without waking the computer, and stopping twice is just a new order");

placed = await placeOrder([], { action: "start", name: "hand" });
assert.deepEqual(placed.body, { rev: 3, woke: "create" });
assert.equal(storage.get("orders").hand.want, "running");
assert.equal(storage.get("orders").hand.from, null);
console.log("PASS: start sets want running and wakes a sleeping computer");

placed = await placeOrder(runningServer, { action: "rm", name: "hand" });
assert.equal(storage.get("orders").hand.want, "gone");
assert.equal(storage.get("orders").hand.force, false);
placed = await placeOrder(runningServer, { action: "rm", name: "hand", force: true });
assert.deepEqual(placed.body, { rev: 5, woke: null });
assert.equal(storage.get("orders").hand.force, true);
assert.equal((await placeOrder(runningServer, { action: "rm", name: "ghost" })).status, 404);
console.log("PASS: rm sets want gone with force, and asking again is a new order");

resetRecords();
storage.set("orders", { a: { name: "a", want: "stopped", force: false, from: "base", task: null, repo: null, rev: 1 } });
storage.set("rev", 1);
placed = await placeOrder([{ id: 42, name: "chimera", status: "stopping" }], { action: "start", name: "a" });
assert.deepEqual(placed.body, { rev: 2, woke: null });
assert.equal(serverPosts().length, 0);
assert.deepEqual([storage.get("orders").a.want, storage.get("orders").a.rev], ["running", 2]);
console.log("PASS: an order made while the computer is going to sleep is kept and waits");

const orderRow = (name, want, rev, extra = {}) => ({ name, want, force: false, from: "base", task: null, repo: null, rev, orderedAt: old, ...extra });
const sendOutcomes = (outcomes, seenRev, workspaces = []) =>
  call("POST", "/report", { token: "agent", body: JSON.stringify({ busy: false, workspaces, outcomes, seenRev }) });

resetRecords();
sockets.push(fakeSocket());
storage.set("orders", {
  made: orderRow("made", "running", 4),
  failed: orderRow("failed", "running", 5),
  gone: orderRow("gone", "gone", 6),
  refused: orderRow("refused", "gone", 7),
  stale: orderRow("stale", "gone", 9),
});
storage.set("results", { gone: { rev: 2, error: "old", at: old } });
storage.set("rev", 9);
res = await sendOutcomes([
  { name: "made", rev: 4, error: null },
  { name: "failed", rev: 5, error: "couldn't clone o/r" },
  { name: "gone", rev: 6, error: null },
  { name: "refused", rev: 7, error: "not deleted. Push it, or add --force to delete anyway." },
  { name: "stale", rev: 8, error: null },
  { name: "nobody", rev: 1, error: null },
  { name: "made", rev: 99, error: null },
], 9);
assert.equal(res.status, 204);
let results = storage.get("results");
assert.deepEqual(Object.keys(storage.get("orders")).sort(), ["failed", "made", "refused", "stale"]);
assert.deepEqual(Object.keys(results).sort(), ["failed", "made", "refused", "stale"]);
assert.deepEqual({ ...results.made, at: undefined }, { rev: 4, error: null, at: undefined });
assert.ok(nearNow(results.made.at));
assert.equal(results.failed.error, "couldn't clone o/r");
assert.equal(results.stale.rev, 8);
assert.deepEqual(nudges(), []);
console.log("PASS: outcomes are stored per order, a finished delete clears its order, and unknown or future outcomes are dropped");

res = await sendOutcomes([], 8);
assert.deepEqual(nudges(), ["orders"]);
sockets[0].sent.length = 0;
res = await call("POST", "/report", { token: "agent", body: JSON.stringify({ busy: false, workspaces: [] }) });
assert.deepEqual(nudges(), []);
console.log("PASS: a report that saw an older order book nudges the computer for another round");

for (const outcomes of [{}, [{ name: "a", rev: "1", error: null }], [{ name: "a", rev: 1 }], [{ name: 1, rev: 1, error: null }], [{ name: "a", rev: -1, error: null }]]) {
  res = await call("POST", "/report", { token: "agent", body: JSON.stringify({ busy: false, workspaces: [], outcomes }) });
  assert.equal(res.status, 400, JSON.stringify(outcomes));
}
res = await call("POST", "/report", { token: "agent", body: JSON.stringify({ busy: false, workspaces: [], seenRev: "1" }) });
assert.equal(res.status, 400);
console.log("PASS: malformed outcomes or seenRev are refused");

res = await call("GET", "/orders", { token: "agent" });
body = await res.json();
assert.equal(body.rev, 9);
const byName = Object.fromEntries(body.orders.map((o) => [o.name, o]));
assert.deepEqual([byName.made.doneRev, byName.made.error], [4, null]);
assert.deepEqual([byName.failed.doneRev, byName.failed.error], [5, "couldn't clone o/r"]);
assert.deepEqual([byName.stale.doneRev, byName.stale.error], [8, null]);
assert.equal(byName.refused.want, "gone");
console.log("PASS: GET /orders lists every order with its outcome and the latest rev");

resetRecords();
storage.set("workspaces", [workspace("made"), workspace("hand", { repo: null, work: null })]);
storage.set("orders", {
  made: orderRow("made", "running", 4),
  pending: orderRow("pending", "running", 6, { task: "t", repo: "o/r" }),
  failed: orderRow("failed", "running", 5, { from: "made" }),
  retried: orderRow("retried", "running", 8),
});
storage.set("results", {
  made: { rev: 4, error: null, at: old },
  failed: { rev: 5, error: "boom", at: old },
  retried: { rev: 7, error: "old failure", at: old },
});
body = await getState(runningServer);
const rows = Object.fromEntries(body.workspaces.map((w) => [w.name, w]));
assert.deepEqual(body.workspaces.map((w) => w.name), ["made", "hand", "pending", "failed", "retried"]);
assert.deepEqual([rows.made.state, rows.made.want, rows.made.rev, rows.made.doneRev, rows.made.error], ["running", "running", 4, 4, null]);
assert.equal(rows.made.branch, "chimera/made");
assert.deepEqual([rows.hand.want, rows.hand.rev, rows.hand.doneRev, rows.hand.error], [null, null, null, null]);
assert.deepEqual(rows.pending, {
  name: "pending", state: null, parent: "base", task: "t", repo: "o/r", branch: null, work: null, agent: null,
  want: "running", rev: 6, doneRev: null, error: null,
});
assert.deepEqual([rows.failed.parent, rows.failed.doneRev, rows.failed.error], ["made", 5, "boom"]);
assert.deepEqual([rows.retried.doneRev, rows.retried.error], [7, null]);
console.log("PASS: /state lists reported containers and orders together, with want, progress and the current error");

res = await call("GET", "/agent", { token: "agent" });
assert.equal(res.status, 426);
const RealResponse = globalThis.Response;
globalThis.WebSocketPair = class { constructor() { this[0] = { side: "client" }; this[1] = fakeSocket(); } };
globalThis.WebSocketRequestResponsePair = class { constructor(request, response) { Object.assign(this, { request, response }); } };
globalThis.Response = class { constructor(body, init) { Object.assign(this, { body, ...init }); } };
resetRecords();
try {
  res = await worker.fetch(
    new Request("https://control.example/agent", { headers: { Authorization: "Bearer agent", Upgrade: "websocket" } }),
    testEnv(),
  );
} finally {
  globalThis.Response = RealResponse;
}
assert.equal(res.status, 101);
assert.deepEqual(res.webSocket, { side: "client" });
assert.equal(sockets.length, 1);
assert.deepEqual([autoResponse.request, autoResponse.response], ["ping", "pong"]);
await placeOrder(runningServer, { action: "new", name: "z" });
assert.deepEqual(sockets[0].sent, ["orders"]);
console.log("PASS: /agent accepts the computer's WebSocket, answers pings while hibernating, and order changes reach it");
