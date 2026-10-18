// Corkboard server: static UI + JSON API + a live event stream (SSE) of everything the agents do.
//   npm run ui     then open http://localhost:4000 (Codespaces: Ports tab, port 4000)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { connect } from "./graph.js";
import { bus, type Ev } from "./events.js";
import { solve } from "./solve.js";
import { resolveIncident } from "./resolve.js";
import { armScenario, resetLive } from "./arm.js";
import { simulatedRunner } from "./simulate.js";
import { snapshot } from "./snapshot.js";
import { q } from "./tools.js";
import { MODELS } from "./agents.js";

const { graph } = await connect();
const PORT = Number(process.env.PORT ?? 4000);
const clients = new Set<http.ServerResponse>();
let history: Ev[] = [];
let running = false;

const publish = (ev: Omit<Ev, "t"> & { t?: number }) => bus.emit("ev", { t: 0, ...ev });
bus.on("ev", (ev: Ev) => {
  history.push(ev); if (history.length > 800) history.shift();
  for (const c of clients) c.write(`data: ${JSON.stringify(ev)}\n\n`);
});

const SCENARIO_LIST = [
  { key: "checkout", variant: 1, label: "Checkout latency spike", note: "memory knows this pattern" },
  { key: "bus", variant: 1, label: "Notifications backlog", note: "memory knows this pattern" },
  { key: "search", variant: 1, label: "Search latency spike", note: "new to the graph" },
  { key: "search", variant: 2, label: "Recommendations timing out", note: "similar to the search case" },
];

const body = (req: http.IncomingMessage) => new Promise<any>((res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { res(b ? JSON.parse(b) : {}); } catch { res({}); } });
});
const json = (res: http.ServerResponse, data: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data));
};
const FILES: Record<string, [string, string]> = {
  "/": ["../ui/index.html", "text/html; charset=utf-8"],
  "/vendor/gsap.min.js": ["../node_modules/gsap/dist/gsap.min.js", "text/javascript"],
};

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (req.method === "GET" && FILES[url.pathname]) {
      const [rel, type] = FILES[url.pathname];
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      return res.end(await readFile(new URL(rel, import.meta.url)));
    }
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`retry: 1500\n\n`);
      for (const ev of history) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      clients.add(res); req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname === "/api/config") return json(res, { models: MODELS, llm: !!process.env.GEMINI_API_KEY, scenarios: SCENARIO_LIST, running });
    if (url.pathname === "/api/snapshot") return json(res, await snapshot(graph, url.searchParams.get("incident") ?? ""));
    if (url.pathname === "/api/incidents")
      return json(res, await q(graph, "MATCH (i:Incident) WHERE i.live = true RETURN i.id AS id, i.title AS title, i.status AS status, i.openedTs AS openedTs ORDER BY i.openedTs DESC"));
    if (url.pathname === "/api/runs")
      return json(res, await q(graph, "MATCH (i:Incident) WHERE i.solveMs IS NOT NULL RETURN i.id AS id, i.title AS title, i.solveMs AS ms, i.solvePath AS path, i.openedTs AS openedTs ORDER BY i.openedTs"));
    if (url.pathname === "/api/people") return json(res, await q(graph, "MATCH (p:Person) RETURN p.id AS id, p.name AS name ORDER BY p.name"));

    if (req.method === "POST" && url.pathname === "/api/arm") {
      const b = await body(req);
      const r = await armScenario(graph, b.scenario, Number(b.variant ?? 1));
      publish({ agent: "System", type: "phase", armed: r.iid, message: `Alert fired: ${r.title} on ${r.alertService} (${r.iid})` });
      return json(res, r);
    }
    if (req.method === "POST" && url.pathname === "/api/solve") {
      const b = await body(req);
      if (running) return json(res, { error: "a run is already in progress" }, 409);
      running = true;
      json(res, { started: true });
      solve(graph, b.incident, { cold: !!b.cold, simulated: !!b.simulate, runner: b.simulate ? simulatedRunner : undefined })
        .catch((e) => publish({ agent: "System", type: "error", fatal: true, message: e instanceof Error ? e.message : String(e) }))
        .finally(() => { running = false; });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/resolve") {
      const b = await body(req);
      const r = await resolveIncident(graph, b.incident, { who: b.who, text: b.text || undefined, type: b.type || undefined });
      publish({ agent: "System", type: "phase", resolved: b.incident, message: `${b.incident} resolved: ${r.fix}. The graph now remembers it.` });
      return json(res, r);
    }
    if (req.method === "POST" && url.pathname === "/api/reset") {
      if (running) return json(res, { error: "a run is in progress" }, 409);
      await resetLive(graph); history = [];
      publish({ agent: "System", type: "phase", reset: true, message: "Board cleared" });
      return json(res, { ok: true });
    }
    json(res, { error: "not found" }, 404);
  } catch (e) {
    json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
  }
}).listen(PORT, "0.0.0.0", () => console.log(`RED STRING board on http://localhost:${PORT}  (models: ${MODELS.join(", ")})`));
