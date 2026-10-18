// Fires a live demo incident with timestamps relative to NOW, so Scout's 1-hour window always works.
//   npm run arm -- checkout        warm: Historian recalls INC-17 (db-proxy pool incidents), "ask Priya"
//   npm run arm -- bus             warm: Historian recalls message-bus schema incidents, "ask Lena"
//   npm run arm -- search 1        COLD: nothing in history matches; agents must reason from scratch
//   (resolve it, then)
//   npm run arm -- search 2        similar incident: this is the memory-speedup moment
//   npm run arm -- --reset         delete everything tagged live:true (before recording)
import { connect, type Graph } from "./graph.js";
import { q } from "./tools.js";

type Scn = {
  alertService: string; metric: string; affected: string[]; title: string;
  culprit: { service: string; kind: string; msg: string; author: string };
  decoy: { service: string; kind: string; msg: string; author: string };
};
export const SCENARIOS: Record<string, Scn[]> = {
  checkout: [{
    alertService: "checkout", metric: "p99_latency", affected: ["checkout", "orders"], title: "Checkout latency spike",
    culprit: { service: "db-proxy", kind: "config", msg: "db-proxy: lower pool_size 200 -> 20 to cut cost", author: "jonas" },
    decoy: { service: "pricing", kind: "copy", msg: "pricing: update promo banner copy", author: "hannah" },
  }],
  bus: [{
    alertService: "notifications", metric: "consumer_lag", affected: ["notifications", "message-bus"], title: "Notifications backlog growing",
    culprit: { service: "message-bus", kind: "schema", msg: "message-bus: rename payment_event.amount field", author: "jonas" },
    decoy: { service: "email-sender", kind: "dep-bump", msg: "email-sender: bump smtp lib", author: "hannah" },
  }],
  search: [
    {
      alertService: "search", metric: "p99_latency", affected: ["search", "catalog"], title: "Search latency spike",
      culprit: { service: "feature-flags", kind: "config", msg: "feature-flags: catalog_cache_ttl_v2 60s -> 0s", author: "jonas" },
      decoy: { service: "search-indexer", kind: "dep-bump", msg: "search-indexer: bump es client", author: "hannah" },
    },
    {
      alertService: "recommendations", metric: "p99_latency", affected: ["recommendations", "catalog", "search"], title: "Recommendations timing out",
      culprit: { service: "feature-flags", kind: "config", msg: "feature-flags: catalog_cache_ttl_v3 120s -> 0s", author: "omar" },
      decoy: { service: "session-store", kind: "refactor", msg: "session-store: tidy eviction code", author: "carlos" },
    },
  ],
};

const MIN = 60_000;
const hex = () => Array.from({ length: 7 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

export async function resetLive(graph: Graph) {
  await graph.query("MATCH (n {live:true}) DETACH DELETE n");
}

export async function armScenario(graph: Graph, key: string, variant = 1) {
  const scn = SCENARIOS[key]?.[variant - 1];
  if (!scn) throw new Error(`unknown scenario ${key} ${variant}`);
  const maxOf = async (cy: string) => Number((await q(graph, cy))[0]?.m ?? 0);
  const incNo = (await maxOf("MATCH (i:Incident) RETURN max(toInteger(substring(i.id, 4))) AS m")) + 1;
  let depNo = (await maxOf("MATCH (d:Deploy) RETURN max(toInteger(substring(d.id, 2))) AS m")) + 1;
  const now = Date.now();

  async function deploy(c: Scn["culprit"], minsAgo: number) {
    const id = `D-${depNo++}`; const ts = now - minsAgo * MIN; const sha = hex();
    await q(graph,
      `MATCH (s:Service {name:$svc}), (p:Person {id:$author})
       CREATE (d:Deploy {id:$id, ts:$ts, env:'prod', live:true})-[:CHANGED]->(s),
              (cm:Commit {id:$cid, kind:$kind, message:$msg, ts:$ts, live:true})-[:PART_OF]->(d),
              (p)-[:AUTHORED]->(cm)`,
      { svc: c.service, author: c.author, id, ts, cid: `C-${sha}`, kind: c.kind, msg: c.msg });
    return id;
  }
  const culpritId = await deploy(scn.culprit, 25); // the real cause
  const decoyId = await deploy(scn.decoy, 10);     // a recent but innocent change (Skeptic's target)

  const iid = `INC-${incNo}`;
  await q(graph,
    `MATCH (s:Service {name:$svc})
     CREATE (i:Incident {id:$iid, title:$title, status:'open', openedTs:$ts, live:true}),
            (a:Alert {id:$aid, name:$aname, metric:$metric, severity:'page', ts:$ts, live:true})-[:FIRED_ON]->(s),
            (i)-[:TRIGGERED_BY]->(a)`,
    { svc: scn.alertService, iid, title: scn.title, ts: now, aid: `AL-${incNo}`, aname: `${scn.alertService} ${scn.metric} breach`, metric: scn.metric });
  await q(graph, "MATCH (i:Incident {id:$iid}), (s:Service) WHERE s.name IN $affected CREATE (i)-[:AFFECTED]->(s)", { iid, affected: scn.affected });
  return { iid, culpritId, decoyId, alertService: scn.alertService, title: scn.title };
}

if (process.argv[1]?.endsWith("arm.ts")) {
  const { db, graph } = await connect();
  if (process.argv.includes("--reset")) {
    await resetLive(graph);
    console.log("live demo data cleared");
  } else {
    const key = process.argv[2];
    try {
      const r = await armScenario(graph, key, Number(process.argv[3] ?? 1));
      console.log(`armed ${r.iid}  alert on ${r.alertService}  culprit=${r.culpritId} (hidden)  decoy=${r.decoyId}`);
      console.log(`next: npm run verify -- ${r.iid}`);
    } catch {
      console.error(`usage: arm <${Object.keys(SCENARIOS).join("|")}> [variant] | --reset`);
      process.exitCode = 1;
    }
  }
  await db.close();
}
