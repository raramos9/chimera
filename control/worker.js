import cloudInit from "../cloud-init.yaml";

const name = "chimera";
const api = "https://api.hetzner.cloud/v1";
const volumeName = "chimera-home";
const primaryIpId = 154132581; // chimera-ip
const firewallId = 11770509; // chimera-firewall

const wakeByStatus = {
  none: "create",
  off: "replace",
  running: "awake",
  initializing: "waking",
  starting: "waking",
  stopping: "busy",
  deleting: "busy",
};

const replies = {
  create: [202, "Waking up. Ready in about a minute."],
  replace: [202, "Waking up. Ready in about a minute."],
  awake: [200, "Already awake."],
  waking: [200, "Already waking up."],
  busy: [409, "Going to sleep. Try again in a minute."],
};

// A brand-new server can report "off" for a moment before it starts.
const graceMinutes = 5;
const forceOffAfterMinutes = 15;

function sweepAction(status, minutes, maxAwake) {
  if (minutes < graceMinutes) return null;
  if (status === "off") return "delete";
  if (minutes >= maxAwake + forceOffAfterMinutes && status !== "deleting") return "poweroff";
  if (minutes >= maxAwake && status === "running") return "shutdown";
  return null;
}

const sweepRequests = {
  delete: (id) => ["DELETE", `/servers/${id}`],
  shutdown: (id) => ["POST", `/servers/${id}/actions/shutdown`],
  poweroff: (id) => ["POST", `/servers/${id}/actions/poweroff`],
};

async function hetzner(env, method, path, body) {
  const headers = { Authorization: `Bearer ${env.HCLOUD_TOKEN}` };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(api + path, {
    method,
    headers,
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function createServer(env) {
  const { volumes } = await hetzner(env, "GET", `/volumes?name=${volumeName}`);
  if (volumes.length !== 1) throw new Error(`expected one volume named ${volumeName}, found ${volumes.length}`);
  return hetzner(env, "POST", "/servers", {
    name,
    server_type: "cpx11",
    image: "ubuntu-24.04",
    location: "hil",
    ssh_keys: ["laptop"],
    volumes: [volumes[0].id],
    automount: false,
    public_net: { enable_ipv4: true, enable_ipv6: true, ipv4: primaryIpId },
    firewalls: [{ firewall: firewallId }],
    user_data: cloudInit,
  });
}

async function deleteAndWait(env, id) {
  const { action } = await hetzner(env, "DELETE", `/servers/${id}`);
  for (let i = 0; i < 30; i++) {
    const { action: current } = await hetzner(env, "GET", `/actions/${action.id}`);
    if (current.status === "error") throw new Error(`deleting server ${id} failed`);
    if (current.status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`deleting server ${id} didn't finish in 30 seconds`);
}

export default {
  async scheduled(event, env) {
    const maxAwake = Number(env.MAX_AWAKE_MINUTES);
    if (!(maxAwake > 0)) throw new Error(`MAX_AWAKE_MINUTES must be a positive number, got ${env.MAX_AWAKE_MINUTES}`);
    const { servers } = await hetzner(env, "GET", `/servers?name=${name}`);
    for (const server of servers) {
      const minutes = (Date.now() - Date.parse(server.created)) / 60000;
      const action = sweepAction(server.status, minutes, maxAwake);
      if (!action) continue;
      console.log(`${action} ${server.name} (${server.id}), ${server.status} for ${Math.floor(minutes)} min`);
      await hetzner(env, ...sweepRequests[action](server.id));
    }
  },

  async fetch(request, env) {
    const text = (message, status) =>
      new Response(message, { status, headers: { "Content-Type": "text/plain" } });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/wake") {
      return text("Not found.", 404);
    }
    if (typeof env.WAKE_TOKEN !== "string" || env.WAKE_TOKEN === ""
      || request.headers.get("Authorization") !== `Bearer ${env.WAKE_TOKEN}`) {
      return text("Wrong password.", 401);
    }

    const { servers } = await hetzner(env, "GET", `/servers?name=${name}`);
    const server = servers[0];
    const outcome = wakeByStatus[server ? server.status : "none"] ?? "busy";
    if (outcome === "create") {
      console.log("creating server");
      await createServer(env);
    } else if (outcome === "replace") {
      console.log(`replacing ${server.name} (${server.id}), powered off`);
      await deleteAndWait(env, server.id);
      await createServer(env);
    }
    const [status, message] = replies[outcome];
    return text(message, status);
  },
};
