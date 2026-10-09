const name = "chimera";
const api = "https://api.hetzner.cloud/v1";

async function hetzner(env, method, path) {
  const res = await fetch(api + path, {
    method,
    headers: { Authorization: `Bearer ${env.HCLOUD_TOKEN}` },
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

export default {
  async scheduled(event, env) {
    const { servers } = await hetzner(env, "GET", `/servers?name=${name}`);
    for (const server of servers) {
      if (server.status !== "off") continue;
      console.log(`deleting ${server.name} (${server.id}), powered off`);
      await hetzner(env, "DELETE", `/servers/${server.id}`);
    }
  },
};
