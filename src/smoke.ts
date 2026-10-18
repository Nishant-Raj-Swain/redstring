// No-LLM smoke test of the whole graph loop. Plays the agents by hand using the real tools.
//   npm run smoke      (needs FalkorDB running; wipes and re-seeds nothing: run `seed` first)
import { connect } from "./graph.js";
import { TOOLS, addEvidence, proposeHypothesis, q, type Ctx } from "./tools.js";
import { resolveIncident } from "./resolve.js";
import { fallbackExplanation } from "./fallback.js";
import { execSync } from "node:child_process";

const { db, graph } = await connect();
const ctx = (agent: string, incidentId: string): Ctx => ({ graph, incidentId, agent });
const ok = (name: string, cond: boolean, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name} ${extra}`); if (!cond) process.exitCode = 1; };
const arm = (s: string, v?: number) => execSync(`npx tsx src/arm.ts ${s} ${v ?? ""}`, { encoding: "utf8" }).match(/armed (INC-\d+)/)![1];
await q(graph, "MATCH (n {live:true}) DETACH DELETE n");

// ---- cold scenario: search #1, nothing in history matches ----
const inc1 = arm("search", 1);
const s = ctx("Scout", inc1);
const blast = (await TOOLS.blast_radius_changes.run(s, {})).result as any[];
ok("scout finds culprit + decoy in window", blast.length === 2, JSON.stringify(blast.map((b) => `${b.deploy}@${b.hops}`)));
const real = blast.find((b) => b.service === "feature-flags").deploy, decoy = blast.find((b) => b.service === "search-indexer").deploy;
const hReal = await proposeHypothesis(s, "flag change caused it", real);
const hDecoy = await proposeHypothesis(s, "es client bump caused it", decoy);
for (const h of [hReal, hDecoy]) for (let i = 0; i < 2; i++) await addEvidence(s, { hid: h, stance: "supports", text: `support ${i}`, about: [{ label: "Deploy", key: h === hReal ? real : decoy }] });
const dup = await proposeHypothesis(ctx("Historian", inc1), "same deploy again", real);
ok("two agents converge on one hypothesis node", dup === hReal);
const hist = (await TOOLS.recall_similar_incidents.run(ctx("Historian", inc1), {})).result as any[];
ok("cold start: only weak recall (overlap<2)", hist.every((h) => h.overlap < 2), JSON.stringify(hist.map((h) => `${h.incident}:${h.overlap}`)));
const sk = ctx("Skeptic", inc1);
const stats = (await TOOLS.root_cause_kind_stats.run(sk, {})).result as any;
ok("skeptic stats: 'dep-bump' has a history, 'copy' has none", stats.allHistory.some((k: any) => k.kind === "dep-bump") && !stats.allHistory.some((k: any) => k.kind === "copy"));
const killed = await addEvidence(sk, { hid: hDecoy, stance: "contradicts", text: "dep-bump" });
ok("contradiction rejects decoy", killed.status === "rejected", `conf=${killed.confidence}`);
const held = await addEvidence(sk, { hid: hReal, stance: "supports", text: "survived checks" });
ok("true culprit stays open with higher confidence", held.status === "open" && held.confidence > killed.confidence, `conf=${held.confidence}`);
const path = (await TOOLS.explain_path.run(ctx("Narrator", inc1), { hypothesis_id: hReal })).result as any;
ok("explain_path: search -> ... -> feature-flags in 3 hops", path.hops === 3, path.route.join(" > "));
const fb = await fallbackExplanation(graph, inc1);
ok("fallback explanation names the surviving deploy, not the rejected decoy", fb.includes(`[${real}]`) && !fb.includes(`[${decoy}]`), fb.slice(0, 80));
const ev = (await q(graph, "MATCH (e:Evidence)-[:ABOUT]->(n) RETURN count(e) AS c"))[0].c;
ok("evidence is pinned to nodes (strings for the board)", ev > 0, `${ev} ABOUT edges`);
await resolveIncident(graph, inc1, { who: "marcus", text: "Reverted flag and warmed cache", type: "revert" });
const st = (await q(graph, "MATCH (i:Incident {id:$id}) RETURN i.status AS s", { id: inc1 }))[0].s;
ok("resolve closes incident", st === "resolved");

// ---- warm scenario: search #2 recalls #1 ----
const inc2 = arm("search", 2);
const rec = (await TOOLS.recall_similar_incidents.run(ctx("Historian", inc2), {})).result as any[];
ok("MEMORY: second incident recalls the first, with the fixer", rec[0]?.incident === inc1 && rec[0].who === "Marcus Chen" && rec[0].rootService === "feature-flags" && rec[0].overlap >= 2, JSON.stringify(rec[0]));

// ---- full solve() fast path up to the LLM-only Narrator ----
let out = "";
try { out = execSync(`GEMINI_API_KEY=dummy GEMINI_BASE_URL=http://127.0.0.1:1 npx tsx src/solve.ts ${inc2} 2>&1`, { encoding: "utf8", timeout: 90_000 }); } catch (e: any) { out = String(e.stdout ?? e); }
ok("solve() takes the memory path", /RECALLED FROM MEMORY/.test(out));
const h2 = await q(graph, "MATCH (h:Hypothesis)-[:EXPLAINS]->(:Incident {id:$id}) OPTIONAL MATCH (e:Evidence {recalled:true})-[:SUPPORTS]->(h) RETURN h.confidence AS c, h.status AS s, count(e) AS recalled", { id: inc2 });
ok("fast path wrote a confident hypothesis with recalled evidence", h2.length === 1 && h2[0].c >= 0.7 && h2[0].recalled === 2, JSON.stringify(h2));

// ---- the whole orchestrator with scripted agents, plus the snapshot the corkboard draws ----
process.env.SIM_PACE = "0";
const { simulatedRunner } = await import("./simulate.js");
const { solve } = await import("./solve.js");
const { snapshot } = await import("./snapshot.js");
await q(graph, "MATCH (n {live:true}) DETACH DELETE n");

const sA = arm("search", 1);
const r1 = await solve(graph, sA, { runner: simulatedRunner, simulated: true });
ok("sim cold run takes the full path and names the real culprit", r1.path === "full" && /\[D-\d+\] on \[feature-flags\]/.test(r1.answer), r1.answer.slice(0, 70));
const snap1 = (await snapshot(graph, sA))!;
const hyp = snap1.nodes.filter((n) => n.type === "hypothesis");
ok("snapshot: two hypotheses, decoy rejected, culprit open", hyp.length === 2 && hyp.filter((h) => h.data?.status === "rejected").length === 1 && hyp.filter((h) => h.data?.status === "open").length === 1,
  JSON.stringify(hyp.map((h) => [h.label, h.data?.status, Number(h.data?.confidence).toFixed(2)])));
ok("snapshot: route strings run search > catalog > cache-layer > feature-flags", ["search", "catalog", "cache-layer", "feature-flags"].every((n, i, a) => i === a.length - 1 || snap1.edges.some((e) => e.id === `svc:${n}>svc:${a[i + 1]}:depends_on`)));
ok("snapshot: evidence cards carry the Cypher that found them", snap1.nodes.filter((n) => n.type === "evidence").every((n) => String(n.data?.cypher).includes("cypher")));
await resolveIncident(graph, sA, { who: "marcus", text: "Reverted flag and warmed cache", type: "revert" });

const sB = arm("search", 2);
const r2 = await solve(graph, sB, { runner: simulatedRunner, simulated: true });
ok("sim warm run takes the MEMORY path and cites the past incident and fixer", r2.path === "memory" && r2.answer.includes(`[${sA}]`) && r2.answer.includes("Marcus Chen"), r2.answer.slice(0, 90));
const snap2 = (await snapshot(graph, sB))!;
ok("snapshot: recalled incident and its fixer appear as cards", snap2.nodes.some((n) => n.type === "past" && n.id === `past:${sA}`) && snap2.edges.some((e) => e.kind === "fixed_by"));
const runs = await q(graph, "MATCH (i:Incident) WHERE i.solveMs IS NOT NULL RETURN i.solvePath AS p ORDER BY i.openedTs");
ok("run history labels simulated runs", runs.length === 2 && runs[0].p === "sim-full" && runs[1].p === "sim-memory", JSON.stringify(runs.map((r) => r.p)));

await q(graph, "MATCH (n {live:true}) DETACH DELETE n");
await db.close();
