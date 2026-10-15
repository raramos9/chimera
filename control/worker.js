import { DurableObject } from "cloudflare:workers";
import cloudInit from "../cloud-init.yaml";
import imageInit from "../image.yaml";

const name = "chimera";
const api = "https://api.hetzner.cloud/v1";
const volumeNames = ["chimera-home", "chimera-machines"];
const imageLabel = "chimera=base";
const buildName = "chimera-image-build";
const keepImages = 2;
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

const stateByStatus = {
  none: "asleep",
  initializing: "waking",
  starting: "waking",
  running: "awake",
  stopping: "going-to-sleep",
  off: "going-to-sleep",
  deleting: "going-to-sleep",
};

const replies = {
  create: [202, "Waking up. Ready in about 30 seconds."],
  replace: [202, "Waking up. Ready in about 30 seconds."],
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

const rebuildAfterDays = 7;
const retryAfterHours = 24;
const giveUpOnBuildMinutes = 60;

const hoursSince = (time) => (Date.now() - Date.parse(time)) / 3600000;

function buildAction(build, images) {
  if (build) {
    if (build.status === "off") {
      const saved = images.find((image) => image.created_from?.id === build.id);
      if (!saved) return "snapshot";
      return saved.status === "available" ? "finish" : null;
    }
    return hoursSince(build.created) * 60 >= giveUpOnBuildMinutes ? "abandon" : null;
  }
  const newest = images.find((image) => image.status === "available");
  if (!newest) return "start";
  const started = Number(newest.labels.build_started ?? 0) * 1000;
  const retryReady = !started || (Date.now() - started) / 3600000 >= retryAfterHours;
  return hoursSince(newest.created) >= rebuildAfterDays * 24 && retryReady ? "start" : null;
}

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

// Hetzner caps user data at 32 KiB and passes it on untouched. cloud-init unzips a MIME part marked application/gzip.
async function packUserData(text) {
  const gzipped = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(gzipped)));
  return [
    'Content-Type: multipart/mixed; boundary="chimera"', "MIME-Version: 1.0", "",
    "--chimera", "Content-Type: application/gzip", "Content-Transfer-Encoding: base64", "",
    base64, "--chimera--", "",
  ].join("\n");
}

async function createServer(env) {
  const volumeIds = [];
  for (const volumeName of volumeNames) {
    const { volumes } = await hetzner(env, "GET", `/volumes?name=${volumeName}`);
    if (volumes.length !== 1) throw new Error(`expected one volume named ${volumeName}, found ${volumes.length}`);
    volumeIds.push(volumes[0].id);
  }
  const { images } = await hetzner(env, "GET",
    `/images?type=snapshot&status=available&label_selector=${encodeURIComponent(imageLabel)}&sort=created:desc`);
  if (images.length === 0) throw new Error(`no snapshot labeled ${imageLabel}, run 'chimera build-image'`);
  return hetzner(env, "POST", "/servers", {
    name,
    server_type: "cpx11",
    image: images[0].id,
    location: "hil",
    ssh_keys: ["laptop"],
    volumes: volumeIds,
    automount: false,
    public_net: { enable_ipv4: true, enable_ipv6: true, ipv4: primaryIpId },
    firewalls: [{ firewall: firewallId }],
    user_data: await packUserData(cloudInit),
  });
}

const buildSteps = {
  async start(env, build, images) {
    await hetzner(env, "POST", "/servers", {
      name: buildName,
      server_type: "cpx11",
      image: "ubuntu-24.04",
      location: "hil",
      ssh_keys: ["laptop"],
      firewalls: [{ firewall: firewallId }],
      user_data: imageInit,
    });
    const newest = images.find((image) => image.status === "available");
    if (newest) {
      const labels = { ...newest.labels, build_started: String(Math.floor(Date.now() / 1000)) };
      await hetzner(env, "PUT", `/images/${newest.id}`, { labels });
    }
  },
  async snapshot(env, build) {
    const [key, value] = imageLabel.split("=");
    await hetzner(env, "POST", `/servers/${build.id}/actions/create_image`, {
      type: "snapshot",
      description: `chimera ${new Date().toISOString().slice(0, 10)}`,
      labels: { [key]: value },
    });
  },
  async finish(env, build, images) {
    await hetzner(env, "DELETE", `/servers/${build.id}`);
    const available = images.filter((image) => image.status === "available");
    for (const old of available.slice(keepImages)) await hetzner(env, "DELETE", `/images/${old.id}`);
  },
  async abandon(env, build) {
    await hetzner(env, "DELETE", `/servers/${build.id}`);
  },
};

async function rebuildImage(env) {
  const { servers } = await hetzner(env, "GET", `/servers?name=${buildName}`);
  const { images } = await hetzner(env, "GET",
    `/images?type=snapshot&label_selector=${encodeURIComponent(imageLabel)}&sort=created:desc`);
  const action = buildAction(servers[0], images);
  if (!action) return;
  console.log(`image build: ${action}`);
  await buildSteps[action](env, servers[0], images);
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

const text = (message, status) =>
  new Response(message, { status, headers: { "Content-Type": "text/plain" } });

const records = (env) => env.RECORDS.get(env.RECORDS.idFromName(name));

const isText = (value) => typeof value === "string";
const isTextOrNull = (value) => value === null || isText(value);
const isLines = (value) => Array.isArray(value) && value.every(isText);
const validWork = (work) =>
  work === null || Boolean(work && isLines(work.unpushed) && isLines(work.uncommitted) && isTextOrNull(work.error));
const validWorkspace = (w) =>
  Boolean(w && isText(w.name) && w.name !== "" && isText(w.state)
    && ["parent", "task", "repo", "branch"].every((key) => isTextOrNull(w[key])) && validWork(w.work)
    && [undefined, null, "working", "waiting"].includes(w.agent));
const isRev = (value) => Number.isInteger(value) && value >= 0;
const validOutcome = (o) => Boolean(o && isText(o.name) && isRev(o.rev) && isTextOrNull(o.error));
const validReport = (body) =>
  Boolean(body && typeof body.busy === "boolean" && Array.isArray(body.workspaces) && body.workspaces.every(validWorkspace)
    && (body.outcomes === undefined || (Array.isArray(body.outcomes) && body.outcomes.every(validOutcome)))
    && (body.seenRev === undefined || isRev(body.seenRev)));

const isName = (value) => isText(value) && /^[a-z][a-z0-9-]{0,62}$/.test(value) && value !== "base";
const isRepo = (value) => isText(value) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
const maxTaskLength = 2000;
const optional = (check) => (value) => value === undefined || value === null || check(value);
const isTask = (value) => isText(value) && value.length <= maxTaskLength;

const adopted = (name) => ({ name, want: null, force: false, from: null, task: null, repo: null });
const missing = (name) => [404, `There's no container called ${name}.`];
const taken = (name) => [409, `There's already a container or an order called ${name}.`];

function setWant(want) {
  return ({ name, force }, { orders, known }) => {
    const order = orders[name];
    if (!known(name)) return { refused: missing(name) };
    if (order?.want === "gone" && want !== "gone") return { refused: [409, `${name} is being deleted.`] };
    return { order: { ...(order ?? adopted(name)), want, force: want === "gone" && force === true } };
  };
}

const orderActions = {
  new: {
    wakes: true,
    place: ({ name, task, repo }, { known }) =>
      known(name) ? { refused: taken(name) } : { order: { name, want: "running", force: false, from: "base", task: task ?? null, repo: repo ?? null } },
  },
  fork: {
    wakes: true,
    place: ({ name, from, task }, { orders, reported, known }) => {
      if (from !== "base" && !reported.has(from) && !(orders[from] && orders[from].want !== "gone")) return { refused: missing(from) };
      if (known(name)) return { refused: taken(name) };
      return { order: { name, want: "running", force: false, from, task: task ?? null, repo: null } };
    },
  },
  start: { wakes: true, place: setWant("running") },
  stop: { wakes: false, place: setWant("stopped") },
  rm: { wakes: true, place: setWant("gone") },
};

const validOrderRequest = (body) =>
  Boolean(body && Object.hasOwn(orderActions, body.action) && isName(body.name)
    && optional(isTask)(body.task) && optional(isRepo)(body.repo) && optional((f) => typeof f === "boolean")(body.force)
    && (body.action !== "fork" || body.from === "base" || isName(body.from)));

function mergeWorkspaces(incoming, previous, now) {
  const before = new Map(previous.map((w) => [w.name, w]));
  return incoming.map((w) => {
    if (w.work) return { ...w, work: { ...w.work, checkedAt: now } };
    const kept = w.repo && before.get(w.name)?.work;
    return kept ? { ...w, work: kept } : w;
  });
}

function computerState(server, reportedAt) {
  const state = stateByStatus[server ? server.status : "none"] ?? "unknown";
  const reportedSinceBoot = reportedAt && Date.parse(reportedAt) > Date.parse(server?.created);
  return state === "awake" && !reportedSinceBoot ? "waking" : state;
}

const ageSeconds = (time, now) => (time ? Math.floor((now - Date.parse(time)) / 1000) : null);

function progress(order, result) {
  if (!order) return { want: null, rev: null, doneRev: null, error: null };
  return {
    want: order.want,
    rev: order.rev,
    doneRev: result?.rev ?? null,
    error: result?.rev === order.rev ? result.error : null,
  };
}

function withOrders(workspaces, orders, results) {
  const reported = new Set(workspaces.map((w) => w.name));
  return [
    ...workspaces.map((w) => ({ ...w, ...progress(orders[w.name], results[w.name]) })),
    ...Object.values(orders).filter((o) => !reported.has(o.name)).map((o) => ({
      name: o.name, state: null, parent: o.from, task: o.task, repo: o.repo, branch: null, work: null, agent: null,
      ...progress(o, results[o.name]),
    })),
  ];
}

function buildState(server, { computer, workspaces, orders, results }, now) {
  return {
    state: computerState(server, computer.reportedAt),
    server: server && {
      status: server.status,
      created: server.created,
      firewalls: server.public_net?.firewalls?.length ?? 0,
    },
    want: computer.want,
    wantAgeSeconds: ageSeconds(computer.wantAt, now),
    busy: computer.busy,
    reportAgeSeconds: ageSeconds(computer.reportedAt, now),
    workspaces: withOrders(workspaces, orders, results).map((w) =>
      w.work ? { ...w, work: { ...w.work, checkAgeSeconds: ageSeconds(w.work.checkedAt, now) } } : w),
  };
}

export class Records extends DurableObject {
  async computer() {
    return (await this.ctx.storage.get("computer"))
      ?? { want: null, wantAt: null, busy: null, reportedAt: null };
  }

  async stored(key, empty) {
    return (await this.ctx.storage.get(key)) ?? empty;
  }

  async report({ busy, workspaces, outcomes = [], seenRev }) {
    const now = new Date().toISOString();
    const previous = await this.stored("workspaces", []);
    await this.ctx.storage.put("workspaces", mergeWorkspaces(workspaces, previous, now));
    await this.ctx.storage.put("computer", { ...(await this.computer()), busy, reportedAt: now });
    if (outcomes.length > 0) await this.settle(outcomes, now);
    if (seenRev !== undefined && (await this.stored("rev", 0)) > seenRev) this.nudge();
  }

  async settle(outcomes, now) {
    const orders = await this.stored("orders", {});
    const results = await this.stored("results", {});
    for (const { name, rev, error } of outcomes) {
      const order = orders[name];
      if (!order || rev > order.rev) continue;
      if (order.want === "gone" && rev === order.rev && error === null) {
        delete orders[name];
        delete results[name];
      } else {
        results[name] = { rev, error, at: now };
      }
    }
    await this.ctx.storage.put("orders", orders);
    await this.ctx.storage.put("results", results);
  }

  async order(request) {
    const orders = await this.stored("orders", {});
    const reported = new Set((await this.stored("workspaces", [])).map((w) => w.name));
    const known = (name) => Boolean(orders[name]) || reported.has(name);
    const placed = orderActions[request.action].place(request, { orders, reported, known });
    if (placed.refused) return placed;
    const rev = (await this.stored("rev", 0)) + 1;
    orders[request.name] = { ...placed.order, rev, orderedAt: new Date().toISOString() };
    await this.ctx.storage.put("orders", orders);
    await this.ctx.storage.put("rev", rev);
    this.nudge();
    return { rev };
  }

  async orders() {
    const orders = await this.stored("orders", {});
    const results = await this.stored("results", {});
    return {
      orders: Object.values(orders).map((o) => ({ ...o, ...progress(o, results[o.name]) })),
      rev: await this.stored("rev", 0),
    };
  }

  nudge() {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send("orders");
      } catch {
        // A closing socket can't take messages. The computer runs a round when it reconnects.
      }
    }
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return text("Expected a WebSocket.", 426);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage() {}

  async setWant(want) {
    const computer = await this.computer();
    if (computer.want === want) return;
    await this.ctx.storage.put("computer", { ...computer, want, wantAt: new Date().toISOString() });
  }

  async read() {
    return {
      computer: await this.computer(),
      workspaces: await this.stored("workspaces", []),
      orders: await this.stored("orders", {}),
      results: await this.stored("results", {}),
    };
  }
}

async function wakeServer(env) {
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
  if (replies[outcome][0] < 400) await records(env).setWant("awake");
  return outcome;
}

async function wake(request, env) {
  const [status, message] = replies[await wakeServer(env)];
  return text(message, status);
}

const json = (body) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

async function placeOrder(request, env) {
  const body = await request.json().catch(() => null);
  if (!validOrderRequest(body)) return text("Bad order.", 400);
  const placed = await records(env).order(body);
  if (placed.refused) return text(placed.refused[1], placed.refused[0]);
  const outcome = orderActions[body.action].wakes ? await wakeServer(env) : null;
  return json({ rev: placed.rev, woke: outcome === "create" || outcome === "replace" ? outcome : null });
}

async function listOrders(request, env) {
  return json(await records(env).orders());
}

async function agent(request, env) {
  return records(env).fetch(request);
}

async function report(request, env) {
  const body = await request.json().catch(() => null);
  if (!validReport(body)) return text("Bad report.", 400);
  await records(env).report(body);
  return new Response(null, { status: 204 });
}

async function want(request, env) {
  const requested = (await request.text()).trim();
  if (requested !== "awake" && requested !== "asleep") return text("Say awake or asleep.", 400);
  await records(env).setWant(requested);
  if (requested === "asleep") {
    const { servers } = await hetzner(env, "GET", `/servers?name=${name}`);
    if (servers[0]?.status === "running") await hetzner(env, ...sweepRequests.shutdown(servers[0].id));
  }
  return new Response(null, { status: 204 });
}

async function state(request, env) {
  const { servers } = await hetzner(env, "GET", `/servers?name=${name}`);
  return json(buildState(servers[0] ?? null, await records(env).read(), Date.now()));
}

const routes = {
  "POST /wake": [["WAKE_TOKEN"], wake],
  "POST /want": [["WAKE_TOKEN"], want],
  "GET /state": [["WAKE_TOKEN", "AGENT_TOKEN"], state],
  "POST /orders": [["WAKE_TOKEN", "AGENT_TOKEN"], placeOrder],
  "GET /orders": [["AGENT_TOKEN"], listOrders],
  "POST /report": [["AGENT_TOKEN"], report],
  "GET /agent": [["AGENT_TOKEN"], agent],
};

function authorized(request, secret) {
  return typeof secret === "string" && secret !== "" && request.headers.get("Authorization") === `Bearer ${secret}`;
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
    if (!servers[0] || servers[0].status === "off") await records(env).setWant("asleep");
    await rebuildImage(env);
  },

  async fetch(request, env) {
    const route = routes[`${request.method} ${new URL(request.url).pathname}`];
    if (!route) return text("Not found.", 404);
    const [tokenNames, handle] = route;
    if (!tokenNames.some((tokenName) => authorized(request, env[tokenName]))) return text("Wrong password.", 401);
    return handle(request, env);
  },
};
