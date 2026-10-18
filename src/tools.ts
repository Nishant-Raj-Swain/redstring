// The agents' tools ARE Cypher. Agents can only see and change the world through these queries,
// and they coordinate only by reading/writing Hypothesis and Evidence nodes.
import type { Graph } from "./graph.js";

export type Rec = Record<string, any>;
export type Ctx = { graph: Graph; incidentId: string; agent: string; lastRead?: { cypher: string; params: Rec } };
type Out = { result: unknown; cypher?: string; params?: Rec; write?: boolean };
export type Tool = { name: string; description: string; input_schema: Rec; run: (ctx: Ctx, input: Rec) => Promise<Out> };

export async function q(graph: Graph, cypher: string, params: Rec = {}): Promise<Rec[]> {
  const r = await graph.query(cypher, { params });
  return (r.data ?? []) as Rec[];
}
const rid = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const obj = (properties: Rec, required: string[] = []) => ({ type: "object", properties, ...(required.length ? { required } : {}) });

// ---- reads ----------------------------------------------------------------

export const Q_INCIDENT = `
MATCH (i:Incident {id:$id})-[:TRIGGERED_BY]->(a:Alert)-[:FIRED_ON]->(t:Service)
OPTIONAL MATCH (i)-[:AFFECTED]->(s:Service)
RETURN i.title AS title, i.status AS status, i.openedTs AS openedTs, a.name AS alert,
       a.ts AS alertTs, t.name AS alertService, collect(DISTINCT s.name) AS affected`;

// SCOUT: blast radius -> recent changes
export const Q_BLAST = (maxHops: number) => `
MATCH p=(t:Service {name:$svc})-[:DEPENDS_ON*0..${maxHops}]->(s:Service)<-[:CHANGED]-(d:Deploy)
WHERE d.ts > $ts - $windowMs AND d.ts <= $ts
WITH d, s, p ORDER BY length(p)
WITH d, s, collect(p)[0] AS best
RETURN d.id AS deploy, d.ts AS deployTs, s.name AS service, length(best) - 1 AS hops,
       [n IN nodes(best) | coalesce(n.name, n.id)] AS route
ORDER BY hops, deployTs DESC`;

export const Q_DEPLOY = `
MATCH (d:Deploy {id:$id})-[:CHANGED]->(s:Service)
OPTIONAL MATCH (d)<-[:PART_OF]-(c:Commit)<-[:AUTHORED]-(p:Person)
OPTIONAL MATCH (o:Person)-[:OWNS]->(s)
RETURN d.id AS deploy, d.ts AS ts, s.name AS service, o.name AS owner,
       collect({commit:c.id, kind:c.kind, message:c.message, author:p.name}) AS commits`;

const Q_SERVICE = `
MATCH (s:Service {name:$svc})
OPTIONAL MATCH (o:Person)-[:OWNS]->(s)
OPTIONAL MATCH (s)-[:DEPENDS_ON]->(dn:Service)
OPTIONAL MATCH (up:Service)-[:DEPENDS_ON]->(s)
OPTIONAL MATCH (rb:Runbook)-[:COVERS]->(s)
RETURN s.name AS service, s.tier AS tier, o.name AS owner, collect(DISTINCT dn.name) AS dependsOn,
       collect(DISTINCT up.name) AS dependedOnBy, collect(DISTINCT rb.title) AS runbooks`;

// HISTORIAN: recall by structural similarity (shared affected services), with the past root-cause pattern
export const Q_RECALL = `
MATCH (cur:Incident {id:$id})-[:AFFECTED]->(s:Service)<-[:AFFECTED]-(past:Incident {status:'resolved'})
WHERE past.id <> $id
WITH past, count(DISTINCT s) AS overlap
MATCH (past)-[:FIXED_BY]->(a:Action)<-[:PERFORMED]-(who:Person)
OPTIONAL MATCH (past)-[:ROOT_CAUSE]->(c:Commit)-[:PART_OF]->(:Deploy)-[:CHANGED]->(rs:Service)
RETURN past.id AS incident, past.title AS title, overlap, a.text AS fix, a.type AS fixType,
       who.name AS who, who.id AS whoId, rs.name AS rootService, c.kind AS rootKind,
       c.message AS rootMessage, past.durationSec AS humanSeconds
ORDER BY overlap DESC, past.openedTs DESC LIMIT 3`;

const Q_PAST = `
MATCH (p:Incident {id:$id})
OPTIONAL MATCH (p)-[:DOCUMENTED_IN]->(pm:Postmortem)
OPTIONAL MATCH (pm)-[:RECORDED]->(dc:Decision)
OPTIONAL MATCH (p)-[:USED_RUNBOOK]->(rb:Runbook)
RETURN p.title AS title, pm.summary AS postmortem, collect(DISTINCT dc.text) AS decisions,
       collect(DISTINCT rb.title) AS runbooks`;

// SKEPTIC: what kinds of change have actually caused incidents here?
const Q_KIND_SCOPED = `
MATCH (cur:Incident {id:$id})-[:AFFECTED]->(s:Service)<-[:AFFECTED]-(past:Incident {status:'resolved'})-[:ROOT_CAUSE]->(c:Commit)
WHERE past.id <> $id
RETURN c.kind AS kind, count(DISTINCT past) AS incidents ORDER BY incidents DESC`;
const Q_KIND_GLOBAL = `
MATCH (past:Incident {status:'resolved'})-[:ROOT_CAUSE]->(c:Commit)
RETURN c.kind AS kind, count(DISTINCT past) AS incidents ORDER BY incidents DESC`;

const Q_HYPOS = `
MATCH (h:Hypothesis)-[:EXPLAINS]->(:Incident {id:$id})
OPTIONAL MATCH (h)-[:IMPLICATES]->(d:Deploy)-[:CHANGED]->(s2:Service)
OPTIONAL MATCH (e:Evidence)-[r:SUPPORTS|CONTRADICTS]->(h)
RETURN h.id AS id, h.text AS text, h.confidence AS confidence, h.status AS status, d.id AS deploy, d.ts AS deployTs, s2.name AS service,
       collect(CASE WHEN e IS NULL THEN null ELSE {id:e.id, rel:type(r), agent:e.agent, text:e.text} END) AS evidence
ORDER BY h.confidence DESC`;

export const Q_ROUTE = `
MATCH (t:Service {name:$from}), (s:Service {name:$to})
WITH shortestPath((t)-[:DEPENDS_ON*..6]->(s)) AS p
RETURN [n IN nodes(p) | n.name] AS route, length(p) AS hops`;

// ---- writes (shared state) -------------------------------------------------

// Confidence is EARNED from the graph, never asserted by an LLM: base 0.3, +0.15 per support, -0.4 per contradiction.
const Q_RESCORE = `
MATCH (h:Hypothesis {id:$hid})
OPTIONAL MATCH (s:Evidence)-[:SUPPORTS]->(h)
WITH h, count(DISTINCT s) AS sup
OPTIONAL MATCH (c:Evidence)-[:CONTRADICTS]->(h)
WITH h, sup, count(DISTINCT c) AS con, 0.3 + 0.15 * sup - 0.4 * count(DISTINCT c) AS raw
SET h.confidence = CASE WHEN raw < 0.02 THEN 0.02 WHEN raw > 0.99 THEN 0.99 ELSE raw END,
    h.status = CASE WHEN h.status = 'confirmed' THEN 'confirmed' WHEN con > 0 AND raw < 0.45 THEN 'rejected' ELSE 'open' END
RETURN h.confidence AS confidence, h.status AS status, sup AS supports, con AS contradictions`;

const ABOUT_KEYS: Record<string, string> = { Deploy: "id", Commit: "id", Service: "name", Incident: "id", Person: "id", Runbook: "id", Decision: "id" };

export async function proposeHypothesis(ctx: Ctx, text: string, deployId: string) {
  const ok = await q(ctx.graph, "MATCH (d:Deploy {id:$d}) RETURN d.id AS id", { d: deployId });
  if (!ok.length) throw new Error(`unknown deploy ${deployId}`);
  const hid = `H-${ctx.incidentId}-${deployId}`; // deterministic: two agents on the same deploy converge on ONE node
  await q(ctx.graph,
    `MATCH (ag:Agent {name:$agent}), (i:Incident {id:$inc}), (d:Deploy {id:$deploy})
     MERGE (h:Hypothesis {id:$hid})
     ON CREATE SET h.text = $text, h.confidence = 0.3, h.status = 'open', h.live = true, h.ts = $ts
     MERGE (ag)-[:PROPOSED]->(h) MERGE (h)-[:EXPLAINS]->(i) MERGE (h)-[:IMPLICATES]->(d)`,
    { agent: ctx.agent, inc: ctx.incidentId, deploy: deployId, hid, text, ts: Date.now() });
  return hid;
}

export async function addEvidence(ctx: Ctx, a: { hid: string; stance: "supports" | "contradicts"; text: string; about?: { label: string; key: string }[]; recalled?: boolean }) {
  if (a.stance !== "supports" && a.stance !== "contradicts") throw new Error("stance must be supports|contradicts");
  const rel = a.stance === "supports" ? "SUPPORTS" : "CONTRADICTS"; // relationship types can't be parameters; value is validated above
  const eid = rid("EV");
  const made = await q(ctx.graph,
    `MATCH (h:Hypothesis {id:$hid}), (ag:Agent {name:$agent})
     CREATE (e:Evidence {id:$eid, text:$text, agent:$agent, stance:$stance, cypher:$cy, recalled:$recalled, ts:$ts, live:true})-[:${rel}]->(h),
            (ag)-[:PINNED]->(e)
     RETURN e.id AS id`,
    { hid: a.hid, agent: ctx.agent, eid, text: a.text, stance: a.stance, recalled: !!a.recalled, ts: Date.now(),
      cy: ctx.lastRead ? JSON.stringify(ctx.lastRead) : "" });
  if (!made.length) throw new Error(`unknown hypothesis ${a.hid}`);
  for (const ab of a.about ?? []) {
    const key = ABOUT_KEYS[ab.label];
    if (!key) continue;
    await q(ctx.graph, `MATCH (e:Evidence {id:$eid}), (n:${ab.label} {${key}:$k}) MERGE (e)-[:ABOUT]->(n)`, { eid, k: ab.key });
  }
  const [score] = await q(ctx.graph, Q_RESCORE, { hid: a.hid });
  return { evidenceId: eid, confidence: score.confidence as number, status: score.status as string, supports: score.supports as number, contradictions: score.contradictions as number };
}


async function routeFor(graph: Graph, from: string, to: string): Promise<{ route: string[]; hops: number }> {
  if (from === to) return { route: [from], hops: 0 };
  const [r] = await q(graph, Q_ROUTE, { from, to });
  return r && r.route ? (r as { route: string[]; hops: number }) : { route: [], hops: -1 };
}
async function header(ctx: Ctx): Promise<Rec> {
  const [row] = await q(ctx.graph, Q_INCIDENT, { id: ctx.incidentId });
  if (!row) throw new Error("incident not found");
  return row;
}
// Hypotheses enriched with everything the Skeptic/Narrator need, so they don't burn model calls on follow-up lookups
async function enrichedHypotheses(ctx: Ctx): Promise<Rec[]> {
  const inc = await header(ctx);
  const rows = await q(ctx.graph, Q_HYPOS, { id: ctx.incidentId });
  for (const h of rows) {
    if (!h.deploy) continue;
    const [d] = await q(ctx.graph, Q_DEPLOY, { id: h.deploy });
    const r = await routeFor(ctx.graph, inc.alertService, h.service);
    h.minutesBeforeAlert = Math.round((inc.alertTs - h.deployTs) / 60000);
    h.hops = r.hops; h.route = r.route; h.owner = d?.owner;
    h.commits = (d?.commits ?? []).filter((c: Rec) => c.commit);
  }
  return rows;
}

// ---- tool registry ----------------------------------------------------------

const aboutSchema = { type: "array", description: "Graph nodes this evidence is pinned to (draws the red strings).",
  items: obj({ label: { type: "string", enum: Object.keys(ABOUT_KEYS) }, key: { type: "string", description: "Deploy/Commit/Incident/Person id, or Service name" } }, ["label", "key"]) };

export const TOOLS: Record<string, Tool> = {
  get_incident: {
    name: "get_incident", description: "Incident header: alert, alerting service, alert timestamp, affected services.",
    input_schema: obj({}),
    async run(ctx) {
      const params = { id: ctx.incidentId };
      const [row] = await q(ctx.graph, Q_INCIDENT, params);
      if (!row) throw new Error("incident not found");
      return { result: row, cypher: Q_INCIDENT, params };
    },
  },
  blast_radius_changes: {
    name: "blast_radius_changes",
    description: "Walk DEPENDS_ON edges downstream from the alerting service and return deploys that CHANGED any service in that radius within the time window, nearest first. Each row already includes the deploy's commits (kind, message, author), the service owner and minutes before the alert.",
    input_schema: obj({ max_hops: { type: "integer", description: "1-6, default 4" }, window_minutes: { type: "integer", description: "default 60" } }),
    async run(ctx, input) {
      const inc = await header(ctx);
      const hops = Math.min(6, Math.max(1, Math.floor(Number(input.max_hops ?? 4))));
      const params = { svc: inc.alertService, ts: inc.alertTs, windowMs: Math.floor(Number(input.window_minutes ?? 60)) * 60_000 };
      const cypher = Q_BLAST(hops);
      const rows = await q(ctx.graph, cypher, params);
      for (const r of rows) {
        const [d] = await q(ctx.graph, Q_DEPLOY, { id: r.deploy });
        r.minutesBeforeAlert = Math.round((inc.alertTs - r.deployTs) / 60000);
        r.owner = d?.owner;
        r.commits = (d?.commits ?? []).filter((c: Rec) => c.commit);
      }
      return { result: rows, cypher, params };
    },
  },
  deploy_details: {
    name: "deploy_details", description: "Commits (kind, message, author) and owning person for a deploy.",
    input_schema: obj({ deploy_id: { type: "string" } }, ["deploy_id"]),
    async run(ctx, i) { const params = { id: i.deploy_id }; return { result: await q(ctx.graph, Q_DEPLOY, params), cypher: Q_DEPLOY, params }; },
  },
  service_context: {
    name: "service_context", description: "Owner, dependencies, dependents and runbooks for a service.",
    input_schema: obj({ service: { type: "string" } }, ["service"]),
    async run(ctx, i) { const params = { svc: i.service }; return { result: await q(ctx.graph, Q_SERVICE, params), cypher: Q_SERVICE, params }; },
  },
  recall_similar_incidents: {
    name: "recall_similar_incidents",
    description: "MEMORY. Resolved incidents that affected the same services as this one, with root-cause pattern, fix and who fixed it. 'overlap' = number of shared affected services.",
    input_schema: obj({}),
    async run(ctx) { const params = { id: ctx.incidentId }; return { result: await q(ctx.graph, Q_RECALL, params), cypher: Q_RECALL, params }; },
  },
  past_incident_detail: {
    name: "past_incident_detail", description: "Postmortem summary, recorded decisions and runbooks for a past incident.",
    input_schema: obj({ incident_id: { type: "string" } }, ["incident_id"]),
    async run(ctx, i) { const params = { id: i.incident_id }; return { result: await q(ctx.graph, Q_PAST, params), cypher: Q_PAST, params }; },
  },
  root_cause_kind_stats: {
    name: "root_cause_kind_stats",
    description: "How often each commit kind (config, schema, copy, dep-bump, ...) was the root cause of past incidents, both for incidents touching the same services and across all history. A kind that has never caused an incident is weak evidence of guilt.",
    input_schema: obj({}),
    async run(ctx) {
      const params = { id: ctx.incidentId };
      const scoped = await q(ctx.graph, Q_KIND_SCOPED, params);
      const global = await q(ctx.graph, Q_KIND_GLOBAL, {});
      return { result: { sameServices: scoped, allHistory: global }, cypher: `${Q_KIND_SCOPED}\n;\n${Q_KIND_GLOBAL}`, params };
    },
  },
  list_hypotheses: {
    name: "list_hypotheses",
    description: "SHARED STATE. All hypotheses on this incident with graph-computed confidence and status, the evidence for/against written by every agent, plus per hypothesis: commits (kind, message, author), owner, hops and route from the alert, minutes before the alert.",
    input_schema: obj({}),
    async run(ctx) { return { result: await enrichedHypotheses(ctx), cypher: Q_HYPOS, params: { id: ctx.incidentId } }; },
  },
  propose_hypothesis: {
    name: "propose_hypothesis",
    description: "Pin a hypothesis that a specific deploy caused this incident, optionally with its first pieces of evidence in the same call (preferred: one call per candidate). Idempotent per deploy. Confidence is computed from evidence, you cannot set it.",
    input_schema: obj({
      deploy_id: { type: "string" }, text: { type: "string", description: "One sentence." },
      evidence: { type: "array", description: "Supporting facts to pin now.", items: obj({ stance: { type: "string", enum: ["supports", "contradicts"] }, text: { type: "string" }, about: aboutSchema }, ["stance", "text"]) },
    }, ["deploy_id", "text"]),
    async run(ctx, i) {
      const hid = await proposeHypothesis(ctx, i.text, i.deploy_id);
      let score: Rec | undefined;
      for (const e of (i.evidence ?? []) as Rec[]) score = await addEvidence(ctx, { hid, stance: e.stance, text: e.text, about: e.about });
      return { result: { hypothesisId: hid, ...(score ? { confidence: score.confidence, status: score.status } : {}) }, write: true };
    },
  },
  add_evidence: {
    name: "add_evidence",
    description: "Pin evidence that supports or contradicts a hypothesis. The query that produced your last read is stored on the evidence so a human can click through to it. Returns the recomputed confidence.",
    input_schema: obj({ hypothesis_id: { type: "string" }, stance: { type: "string", enum: ["supports", "contradicts"] }, text: { type: "string", description: "A concrete graph fact with ids, one sentence." }, about: aboutSchema }, ["hypothesis_id", "stance", "text"]),
    async run(ctx, i) { return { result: await addEvidence(ctx, { hid: i.hypothesis_id, stance: i.stance, text: i.text, about: i.about }), write: true }; },
  },
  case_summary: {
    name: "case_summary",
    description: "Everything the Narrator needs in one call: the best surviving hypothesis with its evidence, the route from the alert, deploy commits and owner, runbooks, any recalled past incident with its fix and who did it, and the hypotheses that were rejected and why.",
    input_schema: obj({}),
    async run(ctx) {
      const inc = await header(ctx);
      const hyps = await enrichedHypotheses(ctx);
      const best = hyps.find((h) => h.status !== "rejected");
      if (!best) throw new Error("no surviving hypothesis");
      const runbooks = (await q(ctx.graph, "MATCH (rb:Runbook)-[:COVERS]->(:Service {name:$svc}) RETURN rb.title AS title", { svc: best.service })).map((r) => r.title);
      const ids = await q(ctx.graph,
        `MATCH (e:Evidence)-[:SUPPORTS]->(:Hypothesis {id:$hid}) MATCH (e)-[:ABOUT]->(p:Incident) WHERE p.id <> $id RETURN DISTINCT p.id AS incident`,
        { hid: best.id, id: ctx.incidentId });
      const recalled: Rec[] = [];
      for (const r of ids) {
        const [past] = await q(ctx.graph, Q_PAST, { id: r.incident });
        const [fix] = await q(ctx.graph, "MATCH (:Incident {id:$id})-[:FIXED_BY]->(a:Action)<-[:PERFORMED]-(w:Person) RETURN a.text AS fix, w.name AS who", { id: r.incident });
        recalled.push({ incident: r.incident, ...past, ...fix });
      }
      const rejected = hyps.filter((h) => h.status === "rejected").map((h) => ({ id: h.id, deploy: h.deploy, service: h.service,
        why: (h.evidence ?? []).filter((e: Rec) => e.rel === "CONTRADICTS").map((e: Rec) => e.text) }));
      return { result: { incident: { id: ctx.incidentId, title: inc.title, alertService: inc.alertService }, best, runbooks, recalledIncidents: recalled, rejected },
        cypher: Q_HYPOS, params: { id: ctx.incidentId } };
    },
  },
  explain_path: {
    name: "explain_path", description: "Shortest DEPENDS_ON route from the alerting service to the service the hypothesis' deploy changed (the red string), plus the deploy's commits and owner. Defaults to the best surviving hypothesis.",
    input_schema: obj({ hypothesis_id: { type: "string" } }),
    async run(ctx, i) {
      let hid = i.hypothesis_id as string | undefined;
      if (!hid) hid = (await enrichedHypotheses(ctx)).find((h) => h.status !== "rejected")?.id;
      const [h] = await q(ctx.graph, "MATCH (h:Hypothesis {id:$hid})-[:IMPLICATES]->(d:Deploy) RETURN d.id AS deploy", { hid });
      if (!h) throw new Error("unknown hypothesis");
      const inc = await header(ctx);
      const [dep] = await q(ctx.graph, Q_DEPLOY, { id: h.deploy });
      const route = await routeFor(ctx.graph, inc.alertService, dep.service);
      return { result: { hypothesis: hid, alertService: inc.alertService, ...route, deploy: dep }, cypher: Q_ROUTE, params: { from: inc.alertService, to: dep.service } };
    },
  },
  save_explanation: {
    name: "save_explanation", description: "Persist the final explanation on the winning hypothesis and the incident (this is what the UI shows).",
    input_schema: obj({ hypothesis_id: { type: "string" }, explanation: { type: "string" } }, ["hypothesis_id", "explanation"]),
    async run(ctx, i) {
      await q(ctx.graph,
        `MATCH (h:Hypothesis {id:$hid})-[:EXPLAINS]->(inc:Incident {id:$id}) SET h.explanation = $text, inc.answer = $text, inc.answerHypothesis = $hid`,
        { hid: i.hypothesis_id, id: ctx.incidentId, text: i.explanation });
      return { result: { saved: true }, write: true };
    },
  },
};
