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
  if (pathname === "/v1/volumes") return new Response(JSON.stringify({ volumes }));
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
  assert.ok(calls.some((c) => c.url === "https://api.hetzner.cloud/v1/images?type=snapshot&status=available&label_selector=chimera%3Dbase&sort=created:desc"));
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

volumes = [{ id: 107072286, name: "chimera-home" }];

async function runBuild(label, buildServers, imageList, check) {
  calls.length = 0;
  builds = buildServers;
  images = imageList;
  list = () => new Response(JSON.stringify({ servers: [] }));
  await worker.scheduled({}, { HCLOUD_TOKEN: "t", MAX_AWAKE_MINUTES: "1440" });
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
