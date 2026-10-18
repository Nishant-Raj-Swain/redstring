// Builds the investigation subgraph the corkboard draws: nodes (cards) and edges (strings), straight from FalkorDB.
import type { Graph } from "./graph.js";
import { q, Q_ROUTE, type Rec } from "./tools.js";

export type SNode = { id: string; type: string; label: string; sub?: string; data?: Rec };
export type SEdge = { id: string; from: string; to: string; kind: string };

export async function snapshot(graph: Graph, incidentId: string) {
  const [inc] = await q(graph,
    `MATCH (i:Incident {id:$id})
     OPTIONAL MATCH (i)-[:TRIGGERED_BY]->(a:Alert)-[:FIRED_ON]->(t:Service)
     OPTIONAL MATCH (i)-[:AFFECTED]->(s:Service)
     RETURN i.id AS id, i.title AS title, i.status AS status, i.openedTs AS openedTs, i.answer AS answer, i.answerHypothesis AS answerHypothesis,
            i.solveMs AS solveMs, i.solvePath AS solvePath, a.id AS alertId, a.name AS alertName, t.name AS alertService, collect(DISTINCT s.name) AS affected`,
    { id: incidentId });
  if (!inc) return null;

  const nodes = new Map<string, SNode>(), edges = new Map<string, SEdge>();
  const node = (id: string, type: string, label: string, sub?: string, data?: Rec) => { if (!nodes.has(id)) nodes.set(id, { id, type, label, sub, data }); return id; };
  const edge = (from: string, to: string, kind: string) => { const id = `${from}>${to}:${kind}`; if (!edges.has(id)) edges.set(id, { id, from, to, kind }); };
  const svc = (name: string, sub?: string) => node(`svc:${name}`, "service", name, sub);

  const incNode = node(`inc:${inc.id}`, "incident", inc.id, inc.title, { status: inc.status, openedTs: inc.openedTs });
  const alertNode = node(`alert:${inc.alertId}`, "alert", inc.alertName, "paged");
  edge(incNode, alertNode, "triggered");
  edge(alertNode, svc(inc.alertService, "failing service"), "fired_on");

  const hyps = await q(graph,
    `MATCH (h:Hypothesis)-[:EXPLAINS]->(:Incident {id:$id})
     OPTIONAL MATCH (h)-[:IMPLICATES]->(d:Deploy)-[:CHANGED]->(s:Service)
     OPTIONAL MATCH (ag:Agent)-[:PROPOSED]->(h)
     RETURN h.id AS id, h.text AS text, h.confidence AS confidence, h.status AS status, h.explanation AS explanation, h.ts AS ts,
            d.id AS deploy, d.ts AS deployTs, s.name AS service, collect(DISTINCT ag.name) AS agents ORDER BY h.ts`, { id: incidentId });

  const implicatedServices = new Set<string>(), deployIds: string[] = [];
  for (const h of hyps) {
    const hn = node(`h:${h.id}`, "hypothesis", h.deploy ? `Deploy ${h.deploy}` : "Hypothesis", h.text, { confidence: h.confidence, status: h.status, agents: h.agents, explanation: h.explanation });
    edge(hn, incNode, "explains");
    if (h.deploy) {
      deployIds.push(h.deploy);
      const mins = Math.round((inc.openedTs - h.deployTs) / 60000);
      const dn = node(`dep:${h.deploy}`, "deploy", h.deploy, `${h.service}, ${mins} min before the alert`, { service: h.service, ts: h.deployTs });
      edge(hn, dn, "implicates");
      edge(dn, svc(h.service), "changed");
      implicatedServices.add(h.service);
    }
  }

  if (deployIds.length) {
    const commits = await q(graph,
      `MATCH (d:Deploy)<-[:PART_OF]-(c:Commit)<-[:AUTHORED]-(p:Person) WHERE d.id IN $ids
       RETURN d.id AS deploy, c.id AS commit, c.kind AS kind, c.message AS message, p.id AS pid, p.name AS pname`, { ids: deployIds });
    for (const c of commits) {
      const cn = node(`commit:${c.commit}`, "commit", c.commit, `${c.kind}: ${c.message}`, { kind: c.kind });
      edge(cn, `dep:${c.deploy}`, "part_of");
      const pn = node(`person:${c.pid}`, "person", c.pname, "author");
      edge(pn, cn, "authored");
    }
    const owners = await q(graph, "MATCH (o:Person)-[:OWNS]->(s:Service) WHERE s.name IN $svcs RETURN o.id AS pid, o.name AS pname, s.name AS service", { svcs: [...implicatedServices] });
    for (const o of owners) edge(node(`person:${o.pid}`, "person", o.pname, "owner"), svc(o.service), "owns");
  }

  // the dependency route from the failing service to every implicated service: the long red strings
  for (const target of implicatedServices) {
    if (target === inc.alertService) continue;
    const [r] = await q(graph, Q_ROUTE, { from: inc.alertService, to: target });
    const route: string[] = r?.route ?? [];
    for (let i = 0; i < route.length; i++) svc(route[i]);
    for (let i = 0; i + 1 < route.length; i++) edge(`svc:${route[i]}`, `svc:${route[i + 1]}`, "depends_on");
  }

  const ev = await q(graph,
    `MATCH (e:Evidence)-[:SUPPORTS|CONTRADICTS]->(h:Hypothesis)-[:EXPLAINS]->(:Incident {id:$id})
     RETURN e.id AS id, e.text AS text, e.agent AS agent, e.stance AS stance, e.cypher AS cypher, e.recalled AS recalled, e.ts AS ts, h.id AS hid ORDER BY e.ts`, { id: incidentId });
  for (const e of ev) {
    const en = node(`ev:${e.id}`, "evidence", e.agent, e.text, { stance: e.stance, cypher: e.cypher, recalled: !!e.recalled, ts: e.ts });
    edge(en, `h:${e.hid}`, e.stance === "contradicts" ? "contradicts" : "supports");
  }

  const about = await q(graph,
    `MATCH (e:Evidence)-[:SUPPORTS|CONTRADICTS]->(:Hypothesis)-[:EXPLAINS]->(:Incident {id:$id})
     MATCH (e)-[:ABOUT]->(n) RETURN e.id AS eid, labels(n)[0] AS label, coalesce(n.name, n.id) AS key, n.name AS name`, { id: incidentId });
  for (const a of about) {
    let target: string;
    if (a.label === "Deploy") target = `dep:${a.key}`;
    else if (a.label === "Commit") target = `commit:${a.key}`;
    else if (a.label === "Service") target = svc(a.key);
    else if (a.label === "Person") target = node(`person:${a.key}`, "person", a.name ?? a.key);
    else if (a.label === "Incident") {
      if (a.key === incidentId) target = incNode;
      else {
        const [p] = await q(graph,
          `MATCH (p:Incident {id:$pid}) OPTIONAL MATCH (p)-[:FIXED_BY]->(ac:Action)<-[:PERFORMED]-(w:Person)
           RETURN p.title AS title, ac.text AS fix, w.id AS wid, w.name AS wname`, { pid: a.key });
        target = node(`past:${a.key}`, "past", a.key, `${p?.title ?? ""}${p?.fix ? ` / fix: ${p.fix}` : ""}`);
        if (p?.wid) edge(target, node(`person:${p.wid}`, "person", p.wname, "fixed it before"), "fixed_by");
      }
    } else continue;
    if (nodes.has(target)) edge(`ev:${a.eid}`, target, "about");
  }

  return { incident: inc, nodes: [...nodes.values()], edges: [...edges.values()] };
}
