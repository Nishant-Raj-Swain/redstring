// Orchestrator. It decides WHICH agents run, never WHAT they conclude; all findings pass through the graph.
//   npm run solve -- INC-18            normal run (memory fast path if the graph recalls a strong match)
//   npm run solve -- INC-18 --cold     memory off: force the full multi-agent investigation
import { connect, type Graph } from "./graph.js";
import { runAgent, LlmUnavailableError } from "./agents.js";
import { makeEmit, type Emit } from "./events.js";
import { fallbackExplanation } from "./fallback.js";
import { TOOLS, addEvidence, proposeHypothesis, q, type Ctx, type Rec } from "./tools.js";

export type Runner = (name: string, prompt: string, graph: Graph, incidentId: string, emit: Emit) => Promise<string>;
export type SolveResult = { incidentId: string; path: "memory" | "full"; ms: number; answer: string; hypothesisId?: string };

export async function solve(graph: Graph, incidentId: string, opts: { cold?: boolean; runner?: Runner; simulated?: boolean } = {}): Promise<SolveResult> {
  const t0 = Date.now();
  const emit = makeEmit(t0);
  const run: Runner = opts.runner ?? runAgent;
  const ctx = (agent: string): Ctx => ({ graph, incidentId, agent });

  const inc = (await TOOLS.get_incident.run(ctx("Historian"), {})).result as Rec;
  emit({ agent: "System", type: "phase", start: true, incident: incidentId, simulated: !!opts.simulated, cold: !!opts.cold,
    message: `${incidentId} "${inc.title}" alert on ${inc.alertService}; affected: ${inc.affected.join(", ")}${opts.simulated ? "  [SIMULATED RUN, no LLM]" : ""}` });

  // A missing Historian/Skeptic degrades the answer but doesn't stop it; a missing Scout means there is nothing to explain.
  const soft = async (name: string, prompt: string) => {
    try { await run(name, prompt, graph, incidentId, emit); }
    catch (e) {
      if (name === "Scout") throw e;
      emit({ agent: name, type: "error", message: `${name} skipped: ${e instanceof Error ? e.message : e}` });
    }
  };

  // 1. Memory recall: one Cypher query, no LLM. This is what makes the second incident fast.
  let path: "memory" | "full" = "full";
  if (!opts.cold) {
    const hctx = ctx("Historian");
    const recall = await TOOLS.recall_similar_incidents.run(hctx, {});
    hctx.lastRead = { cypher: recall.cypher!, params: recall.params ?? {} };
    const top = (recall.result as Rec[])[0];
    emit({ agent: "Historian", type: "result", summary: top ? `top recall ${top.incident} (overlap ${top.overlap}, ${top.rootService}/${top.rootKind})` : "no similar incidents", cypher: recall.cypher, params: recall.params });

    if (top && top.overlap >= 2 && top.rootService && top.rootKind) {
      // 2. Verify the remembered pattern against the live graph: same service + same commit kind, in the blast radius, before the alert.
      const verify = `
MATCH p=(t:Service {name:$svc})-[:DEPENDS_ON*0..4]->(s:Service {name:$root})<-[:CHANGED]-(d:Deploy)<-[:PART_OF]-(c:Commit {kind:$kind})
WHERE d.ts > $ts - 3600000 AND d.ts <= $ts
RETURN d.id AS deploy, c.id AS commit, c.message AS message, length(p) - 2 AS hops
ORDER BY hops, d.ts DESC`;
      const vparams = { svc: inc.alertService, ts: inc.alertTs, root: top.rootService, kind: top.rootKind };
      const cands = await q(graph, verify, vparams);
      hctx.lastRead = { cypher: verify, params: vparams };
      if (cands.length) {
        path = "memory";
        const c = cands[0];
        emit({ agent: "System", type: "phase", memory: true, message: `RECALLED FROM MEMORY: ${top.incident} -> ${c.deploy} matches (${top.rootService}, ${top.rootKind}). Skipping full search.` });
        const hid = await proposeHypothesis(hctx, `Deploy ${c.deploy} (${c.message}) caused this, same pattern as ${top.incident}.`, c.deploy);
        const mins = Math.round((top.humanSeconds ?? 0) / 60);
        await addEvidence(hctx, { hid, stance: "supports", recalled: true, about: [{ label: "Incident", key: top.incident }, { label: "Person", key: top.whoId }],
          text: `Recalled from memory: ${top.incident} (${top.title}) had the same root-cause pattern (${top.rootService}, ${top.rootKind}); fixed by "${top.fix}" (${top.who})${mins >= 1 ? `, resolved in ${mins} min` : ""}.` });
        await addEvidence(hctx, { hid, stance: "supports", about: [{ label: "Deploy", key: c.deploy }, { label: "Service", key: top.rootService }],
          text: `${c.deploy} changed ${top.rootService}, ${c.hops} hop(s) downstream of ${inc.alertService}, shortly before the alert.` });
        await addEvidence(hctx, { hid, stance: "supports", recalled: true, about: [{ label: "Commit", key: c.commit }],
          text: `Commit ${c.commit} is kind "${top.rootKind}", the same kind that caused ${top.incident}.` });
      } else {
        emit({ agent: "System", type: "phase", message: `Recalled ${top.incident} but its pattern isn't present in this blast radius. Falling back to full investigation.` });
      }
    } else {
      emit({ agent: "System", type: "phase", message: "No strong memory match (cold start). Running the full investigation." });
    }
  }

  if (path === "full") {
    for (const a of ["Scout", "Historian", "Skeptic"]) {
      emit({ agent: a, type: "phase", message: `${a} starts` });
      await soft(a, `Investigate incident ${incidentId}.`);
    }
    // A Skeptic that wrote nothing leaves every hypothesis tied, so give it one firmer second pass.
    const [sk] = await q(graph, "MATCH (e:Evidence {agent:'Skeptic'})-[:SUPPORTS|CONTRADICTS]->(:Hypothesis)-[:EXPLAINS]->(:Incident {id:$id}) RETURN count(e) AS c", { id: incidentId });
    if (!sk?.c) {
      emit({ agent: "Skeptic", type: "phase", message: "Skeptic wrote no evidence, retrying" });
      await soft("Skeptic", `You wrote no evidence on ${incidentId}. Call list_hypotheses and root_cause_kind_stats now, then call add_evidence for EVERY hypothesis (contradicts or supports) in one round.`);
    }
  }

  emit({ agent: "Narrator", type: "phase", message: "Narrator starts" });
  const hasAnswer = async () => !!((await q(graph, "MATCH (i:Incident {id:$id}) RETURN i.answer AS a", { id: incidentId }))[0]?.a);
  let reason = "the Narrator agent returned no answer";
  try {
    await run("Narrator", `Explain the answer for incident ${incidentId}.`, graph, incidentId, emit);
    if (!(await hasAnswer())) {
      emit({ agent: "Narrator", type: "phase", message: "Narrator saved no answer, retrying" });
      await run("Narrator", `You have not saved an explanation for ${incidentId}. Call case_summary, then save_explanation. Do not stop before saving.`, graph, incidentId, emit);
    }
  } catch (e) {
    reason = e instanceof LlmUnavailableError ? "no language model was available (quota)" : "the model call failed";
    emit({ agent: "Narrator", type: "error", message: e instanceof Error ? e.message : String(e) });
  }
  if (!(await hasAnswer())) {
    emit({ agent: "Narrator", type: "phase", message: "Narrator agent produced no answer: building it from the graph" });
    await fallbackExplanation(graph, incidentId, reason);
  }

  const ms = Date.now() - t0;
  const label = (opts.simulated ? "sim-" : "") + path;
  const [row] = await q(graph, "MATCH (i:Incident {id:$id}) SET i.solveMs = $ms, i.solvePath = $path RETURN i.answer AS answer, i.answerHypothesis AS hid", { id: incidentId, ms, path: label });
  emit({ agent: "System", type: "phase", done: true, ms, path: label, message: `DONE in ${(ms / 1000).toFixed(1)}s via ${path === "memory" ? "MEMORY" : "full investigation"}` });
  return { incidentId, path, ms, answer: row?.answer ?? "", hypothesisId: row?.hid };
}

if (process.argv[1]?.endsWith("solve.ts")) {
  const id = process.argv[2];
  if (!id) { console.error("usage: solve <incident-id> [--cold]"); process.exit(1); }
  const { db, graph } = await connect();
  try {
    const r = await solve(graph, id, { cold: process.argv.includes("--cold") });
    console.log(`\nANSWER\n${r.answer}\n\nnext: npm run resolve -- ${id} --who <person-id>`);
  } catch (e) {
    console.error(`\n${e instanceof LlmUnavailableError ? e.message : e}`);
    process.exitCode = 1;
  }
  await db.close();
}
