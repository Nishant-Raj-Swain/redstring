// The learning loop. Closing an incident writes ROOT_CAUSE + FIXED_BY edges, and from that moment
// the Historian's recall query can find it. No retraining, no vector store: just new edges.
//   npm run resolve -- INC-18 --who marcus [--text "Reverted flag"] [--type revert]
import { connect, type Graph } from "./graph.js";
import { q } from "./tools.js";

export async function resolveIncident(graph: Graph, id: string, o: { who: string; text?: string; type?: string }) {
  const [top] = await q(graph,
    `MATCH (h:Hypothesis)-[:EXPLAINS]->(:Incident {id:$id}) WHERE h.status <> 'rejected'
     MATCH (h)-[:IMPLICATES]->(d:Deploy)-[:CHANGED]->(s:Service)
     RETURN h.id AS hid, d.id AS did, s.name AS service, h.explanation AS expl
     ORDER BY h.confidence DESC LIMIT 1`, { id });
  if (!top) throw new Error(`no live hypothesis for ${id}; run solve first`);
  const now = Date.now();
  const text = o.text ?? `Rolled back ${top.service} deploy ${top.did}`;

  await q(graph,
    `MATCH (i:Incident {id:$id}), (d:Deploy {id:$did}), (p:Person {id:$who})
     SET i.status = 'resolved', i.resolvedTs = $now, i.durationSec = toInteger(($now - i.openedTs) / 1000)
     MERGE (i)-[:ROOT_CAUSE]->(d)
     CREATE (i)-[:FIXED_BY]->(:Action {id:$aid, type:$type, text:$text, live:true})<-[:PERFORMED]-(p)`,
    { id, did: top.did, who: o.who, now, aid: `ACT-${id.slice(4)}`, type: o.type ?? "rollback", text });
  // ROOT_CAUSE to the deploy's commits too (the Historian reads the commit kind from there). One row per commit, MERGE keeps it idempotent.
  await q(graph, `MATCH (i:Incident {id:$id}), (c:Commit)-[:PART_OF]->(:Deploy {id:$did}) MERGE (i)-[:ROOT_CAUSE]->(c)`, { id, did: top.did });
  await q(graph, `MATCH (h:Hypothesis {id:$hid}) SET h.status = 'confirmed'`, { hid: top.hid });
  await q(graph,
    `MATCH (i:Incident {id:$id}) CREATE (i)-[:DOCUMENTED_IN]->(:Postmortem {id:$pid, title:$title, summary:$summary, live:true})`,
    { id, pid: `PM-${id.slice(4)}`, title: `Postmortem: ${id}`, summary: `${top.expl ?? ""} Fix: ${text}.`.trim() });
  return { incident: id, deploy: top.did, fix: text };
}

if (process.argv[2]?.startsWith("INC-")) {
  const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const who = arg("who");
  if (!who) { console.error("usage: resolve <incident-id> --who <person-id> [--text ...] [--type ...]"); process.exit(1); }
  const { db, graph } = await connect();
  console.log(await resolveIncident(graph, process.argv[2], { who, text: arg("text"), type: arg("type") }));
  console.log("memory updated: the next similar incident will recall this one.");
  await db.close();
}
