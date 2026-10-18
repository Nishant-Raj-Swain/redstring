import { connect, GRAPH_NAME, type Graph } from "./graph.js";
import { generate, type Row } from "./data.js";
import { createSchema } from "./schema.js";

async function load(graph: Graph, name: string, cypher: string, rows: Row[], batch = 150) {
  for (let i = 0; i < rows.length; i += batch)
    await graph.query(`UNWIND $rows AS r ${cypher}`, { params: { rows: rows.slice(i, i + batch) } });
  console.log(`  ${name.padEnd(12)} ${rows.length}`);
}

const d = generate();

if (process.argv.includes("--dry")) {
  for (const [k, v] of Object.entries(d)) console.log(k.padEnd(12), v.length);
  process.exit(0);
}

const { db, graph } = await connect();
console.log(`seeding graph "${GRAPH_NAME}"`);
try { await graph.delete(); } catch { /* graph didn't exist yet */ }
await graph.query("MERGE (:__init {k:1})");
await createSchema(graph);
await graph.query("MATCH (n:__init) DELETE n");

await load(graph, "services", "CREATE (:Service {name:r.name, layer:r.layer, tier:r.tier})", d.services);
await load(graph, "people", "CREATE (:Person {id:r.id, name:r.name, team:r.team})", d.people);
await load(graph, "agents", "CREATE (:Agent {name:r.name, role:r.role})", d.agents);
await load(graph, "runbooks", "CREATE (:Runbook {id:r.id, title:r.title})", d.runbooks);
await load(graph, "depends_on", "MATCH (a:Service {name:r.from}), (b:Service {name:r.to}) CREATE (a)-[:DEPENDS_ON]->(b)", d.deps);
await load(graph, "owns", "MATCH (p:Person {id:r.person}), (s:Service {name:r.service}) CREATE (p)-[:OWNS]->(s)", d.owns);
await load(graph, "covers", "MATCH (rb:Runbook {id:r.runbook}), (s:Service {name:r.service}) CREATE (rb)-[:COVERS]->(s)", d.covers);
await load(graph, "deploys", "MATCH (s:Service {name:r.service}) CREATE (:Deploy {id:r.id, ts:r.ts, env:r.env})-[:CHANGED]->(s)", d.deploys);
await load(graph, "commits",
  `MATCH (dp:Deploy {id:r.deploy}), (p:Person {id:r.author})
   CREATE (c:Commit {id:r.id, kind:r.kind, message:r.message, ts:r.ts})-[:PART_OF]->(dp), (p)-[:AUTHORED]->(c)`, d.commits);
await load(graph, "incidents",
  "CREATE (:Incident {id:r.id, title:r.title, status:r.status, openedTs:r.openedTs, resolvedTs:r.resolvedTs, durationSec:r.durationSec})", d.incidents);
await load(graph, "alerts",
  `MATCH (i:Incident {id:r.incident}), (s:Service {name:r.service})
   CREATE (a:Alert {id:r.id, name:r.name, metric:r.metric, severity:r.severity, ts:r.ts})-[:FIRED_ON]->(s), (i)-[:TRIGGERED_BY]->(a)`, d.alerts);
await load(graph, "affected", "MATCH (i:Incident {id:r.incident}), (s:Service {name:r.service}) CREATE (i)-[:AFFECTED]->(s)", d.affected);
await load(graph, "root_cause",
  "MATCH (i:Incident {id:r.incident}), (dp:Deploy {id:r.deploy}), (c:Commit {id:r.commit}) CREATE (i)-[:ROOT_CAUSE]->(dp), (i)-[:ROOT_CAUSE]->(c)", d.rootCauses);
await load(graph, "actions",
  "MATCH (i:Incident {id:r.incident}), (p:Person {id:r.who}) CREATE (i)-[:FIXED_BY]->(:Action {id:r.id, type:r.type, text:r.text})<-[:PERFORMED]-(p)", d.actions);
await load(graph, "postmortems",
  "MATCH (i:Incident {id:r.incident}) CREATE (i)-[:DOCUMENTED_IN]->(:Postmortem {id:r.id, title:r.title, summary:r.summary})", d.postmortems);
await load(graph, "decisions",
  `MATCH (pm:Postmortem {id:r.postmortem}), (p:Person {id:r.who}), (s:Service {name:r.service})
   CREATE (pm)-[:RECORDED]->(dc:Decision {id:r.id, text:r.text, ts:r.ts}), (dc)-[:MADE_BY]->(p), (dc)-[:ABOUT]->(s)`, d.decisions);
await load(graph, "runbook_use", "MATCH (i:Incident {id:r.incident}), (rb:Runbook {id:r.runbook}) CREATE (i)-[:USED_RUNBOOK]->(rb)", d.runbookUse);

const c = await graph.query("MATCH (n) RETURN count(n) AS nodes");
const e = await graph.query("MATCH ()-[r]->() RETURN count(r) AS edges");
console.log("done:", c.data?.[0], e.data?.[0]);
await db.close();
