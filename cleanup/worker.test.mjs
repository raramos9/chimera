import assert from "node:assert/strict";

const calls = [];
let list = () => new Response(JSON.stringify({ servers: [] }));

globalThis.fetch = async (url, init) => {
  calls.push({ url, method: init.method, headers: init.headers });
  if (init.method === "DELETE") return new Response(JSON.stringify({ action: {} }));
  return list();
};

const { default: worker } = await import("./worker.js");

async function run(label, servers, check) {
  calls.length = 0;
  list = () => new Response(JSON.stringify({ servers }));
  await worker.scheduled({}, { HCLOUD_TOKEN: "t" });
  check();
  console.log(`PASS: ${label}`);
}

const deletes = () => calls.filter((c) => c.method === "DELETE");

await run("powered-off server is deleted", [{ id: 42, name: "chimera", status: "off" }], () => {
  assert.equal(calls[0].url, "https://api.hetzner.cloud/v1/servers?name=chimera");
  assert.equal(deletes().length, 1);
  assert.equal(deletes()[0].url, "https://api.hetzner.cloud/v1/servers/42");
  for (const c of calls) assert.equal(c.headers.Authorization, "Bearer t");
});

await run("running server is left alone", [{ id: 42, name: "chimera", status: "running" }], () => {
  assert.equal(deletes().length, 0);
});

await run("no server is a no-op", [], () => {
  assert.equal(deletes().length, 0);
});

calls.length = 0;
list = () => new Response("unauthorized", { status: 401 });
await assert.rejects(worker.scheduled({}, { HCLOUD_TOKEN: "t" }), /GET \/servers\?name=chimera: 401 unauthorized/);
assert.equal(deletes().length, 0);
console.log("PASS: list failure rejects");
