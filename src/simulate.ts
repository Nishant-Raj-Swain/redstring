// Scripted agents for UI development and for demos when LLM quota is gone. They play the same roles through the SAME tools and the same
// graph writes as the real agents; only the reasoning is scripted. Runs are labelled "simulated" everywhere (log, run history).
import type { Graph } from "./graph.js";
import type { Emit } from "./events.js";
import { TOOLS, type Ctx, type Rec } from "./tools.js";

const pace = Number(process.env.SIM_PACE ?? 1);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * pace));
const summarize = (r: unknown) => (Array.isArray(r) ? `${r.length} rows` : r && typeof r === "object" ? JSON.stringify(r).slice(0, 110) : String(r));

async function call(ctx: Ctx, emit: Emit, name: string, input: Rec) {
  emit({ agent: ctx.agent, type: "tool", name, input });
  await sleep(500);
  const out = await TOOLS[name].run(ctx, input);
  if (out.cypher && !out.write) ctx.lastRead = { cypher: out.cypher, params: out.params ?? {} };
  emit({ agent: ctx.agent, type: "result", name, summary: summarize(out.result), cypher: out.cypher, params: out.params, write: !!out.write, data: out.result });
  await sleep(400);
  return out.result as any;
}

export async function simulatedRunner(name: string, _prompt: string, graph: Graph, incidentId: string, emit: Emit): Promise<string> {
  const ctx: Ctx = { graph, incidentId, agent: name };

  if (name === "Scout") {
    const rows = (await call(ctx, emit, "blast_radius_changes", {})) as Rec[];
    for (const r of rows.slice(0, 4)) {
      const c = r.commits?.[0] ?? {};
      await call(ctx, emit, "propose_hypothesis", {
        deploy_id: r.deploy, text: `Deploy ${r.deploy} (${c.message ?? "change"}) caused this incident.`,
        evidence: [
          { stance: "supports", about: [{ label: "Deploy", key: r.deploy }, { label: "Service", key: r.service }],
            text: `${r.deploy} changed ${r.service}, ${r.hops} hop(s) downstream of the alert (${r.route.slice(0, -1).join(" -> ")}), ${r.minutesBeforeAlert} min before it fired.` },
          { stance: "supports", about: [{ label: "Commit", key: c.commit }], text: `Commit ${c.commit} (${c.kind}): "${c.message}" by ${c.author}.` },
          { stance: "supports", about: [{ label: "Service", key: r.service }], text: `${r.service} is owned by ${r.owner}.` },
        ],
      });
    }
    const t = `Pinned ${Math.min(4, rows.length)} candidate deploys.`; emit({ agent: name, type: "text", text: t }); return t;
  }

  if (name === "Historian") {
    const recall = (await call(ctx, emit, "recall_similar_incidents", {})) as Rec[];
    const hyps = (await call(ctx, emit, "list_hypotheses", {})) as Rec[];
    const top = recall[0];
    let t = "Only weak matches (overlap 1). Nothing to add.";
    if (top && top.overlap >= 2) {
      for (const h of hyps) {
        if (h.service === top.rootService && h.commits?.[0]?.kind === top.rootKind)
          await call(ctx, emit, "add_evidence", { hypothesis_id: h.id, stance: "supports", about: [{ label: "Incident", key: top.incident }, { label: "Person", key: top.whoId }],
            text: `${top.incident} (${top.title}) had the same pattern (${top.rootService}, ${top.rootKind}); fixed by "${top.fix}" (${top.who}).` });
      }
      t = `Matched ${top.incident}.`;
    }
    emit({ agent: name, type: "text", text: t }); return t;
  }

  if (name === "Skeptic") {
    const hyps = (await call(ctx, emit, "list_hypotheses", {})) as Rec[];
    const stats = (await call(ctx, emit, "root_cause_kind_stats", {})) as { sameServices: Rec[]; allHistory: Rec[] };
    const COSMETIC = new Set(["copy", "dep-bump", "refactor"]);
    const seen = (k: string) => stats.sameServices.some((x) => x.kind === k);
    let killed = 0;
    for (const h of hyps) {
      const k = h.commits?.[0]?.kind ?? "change";
      if (!seen(k) && COSMETIC.has(k)) {
        killed++;
        await call(ctx, emit, "add_evidence", { hypothesis_id: h.id, stance: "contradicts", about: [{ label: "Commit", key: h.commits?.[0]?.commit }],
          text: `A "${k}" commit has never been the root cause of an incident touching these services, and "${h.commits?.[0]?.message}" has no behavioural effect.` });
      } else {
        const n = stats.allHistory.find((x) => x.kind === k)?.incidents ?? 0;
        await call(ctx, emit, "add_evidence", { hypothesis_id: h.id, stance: "supports", about: [{ label: "Deploy", key: h.deploy }],
          text: `Survived scrutiny: deployed ${h.minutesBeforeAlert} min before the alert, ${h.hops} hop(s) away, and "${k}" changes have caused ${n} past incident(s).` });
      }
    }
    const t = `Killed ${killed}, ${hyps.length - killed} survived.`; emit({ agent: name, type: "text", text: t }); return t;
  }

  // Narrator
  const cs = (await call(ctx, emit, "case_summary", {})) as Rec;
  const b = cs.best, c = b.commits?.[0] ?? {}, r = cs.recalledIncidents?.[0];
  const text = `${cs.incident.title}: deploy [${b.deploy}] on [${b.service}] (${c.kind}: "${c.message}", commit [${c.commit}] by ${c.author}) is the likely cause, ${b.hops} hop(s) from the alert: ${b.route.join(" -> ")}. `
    + (r ? `It matches [${r.incident}], fixed by "${r.fix}" (${r.who}); ask ${r.who}. ` : `No past incident matches; ask ${b.owner}. `)
    + (cs.runbooks[0] ? `Runbook: ${cs.runbooks[0]}. ` : "")
    + (cs.rejected.length ? `The Skeptic ruled out ${cs.rejected.map((d: Rec) => `[${d.deploy}]`).join(", ")}.` : "");
  await call(ctx, emit, "save_explanation", { hypothesis_id: b.id, explanation: text });
  emit({ agent: name, type: "text", text }); return text;
}
