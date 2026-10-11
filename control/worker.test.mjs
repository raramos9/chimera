import assert from "node:assert/strict";
import fs from "node:fs";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

const hook = `
import fs from "node:fs";
import { fileURLToPath } from "node:url";
export async function load(url, context, nextLoad) {
  if (!url.endsWith(".yaml")) return nextLoad(url, context);
  const text = fs.readFileSync(fileURLToPath(url), "utf8");
  return { format: "module", shortCircuit: true, source: "export default " + JSON.stringify(text) };
}
`;
register("data:text/javascript," + encodeURIComponent(hook));

const calls = [];
let list = () => new Response(JSON.stringify({ servers: [] }));
let actionPolls = 0;
let volumes = [{ id: 107072286, name: "chimera-home" }];
let images = [{ id: 555 }, { id: 444 }];

globalThis.fetch = async (url, init) => {
  const { pathname } = new URL(url);
  calls.push({ url, method: init.method, headers: init.headers, body: init.body });
  if (init.method === "DELETE") return new Response(JSON.stringify({ action: { id: 7, status: "running" } }));
  if (init.method === "POST") return new Response(JSON.stringify({ server: { id: 1 } }));
  if (pathname === "/v1/volumes") return new Response(JSON.stringify({ volumes }));
  if (pathname === "/v1/images") return new Response(JSON.stringify({ images }));
  if (pathname === "/v1/actions/7") {
    return new Response(JSON.stringify({ action: { id: 7, status: actionPolls++ === 0 ? "running" : "success" } }));
  }
  return list();
};

const { default: worker } = await import("./worker.js");

async function run(label, servers, check) {
  calls.length = 0;
  list = () => new Response(JSON.stringify({ servers }));
  await worker.scheduled({}, { HCLOUD_TOKEN: "t", MAX_AWAKE_MINUTES: "1440" });
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
    { HCLOUD_TOKEN: "t", WAKE_TOKEN: token },
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
  assert.ok(calls.some((c) => c.url === "https://api.hetzner.cloud/v1/images?type=snapshot&label_selector=chimera%3Dbase&sort=created:desc"));
  assert.equal(posts()[0].url, "https://api.hetzner.cloud/v1/servers");
  assert.equal(posts()[0].headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(posts()[0].body), {
    name: "chimera",
    server_type: "cpx11",
    image: 555,
    location: "hil",
    ssh_keys: ["laptop"],
    volumes: [107072286],
    automount: false,
    public_net: { enable_ipv4: true, enable_ipv6: true, ipv4: 154132581 },
    firewalls: [{ firewall: 11770509 }],
    user_data: fs.readFileSync(fileURLToPath(new URL("../cloud-init.yaml", import.meta.url)), "utf8"),
  });
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
    "GET /v1/images",
    "POST /v1/servers",
  ]);
});

volumes = [];
await runWake("missing volume refuses to create a server", [], () => wake("pw").catch((e) => e), async (err) => {
  assert.match(err.message, /expected one volume named chimera-home, found 0/);
  assert.equal(posts().length, 0);
});

volumes = [{ id: 107072286, name: "chimera-home" }];
images = [];
await runWake("missing image refuses to create a server", [], () => wake("pw").catch((e) => e), async (err) => {
  assert.match(err.message, /no snapshot labeled chimera=base/);
  assert.equal(posts().length, 0);
});
