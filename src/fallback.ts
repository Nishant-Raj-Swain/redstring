// Last-resort safety net: if the Narrator agent returns nothing (or no model is available), build the answer straight from the graph.
import type { Graph } from "./graph.js";
import { TOOLS, q, type Ctx } from "./tools.js";

export async function fallbackExplanation(graph: Graph, incidentId: string, reason = "the Narrator agent returned no answer"): Promise<string> {
  const ctx: Ctx = { graph, incidentId, agent: "Narrator" };
  const [top] = await q(graph,
    `MATCH (h:Hypothesis)-[:EXPLAINS]->(:Incident {id:$id}) WHERE h.status <> 'rejected'
     RETURN h.id AS hid, h.confidence AS conf ORDER BY h.confidence DESC LIMIT 1`, { id: incidentId });
  if (!top) return "";
  const p = (await TOOLS.explain_path.run(ctx, { hypothesis_id: top.hid })).result as any;
  const d = p.deploy, c = d.commits?.find((x: any) => x.commit) ?? {};
  const text = `Most likely cause: deploy [${d.deploy}] on [${d.service}] (${c.kind ?? "change"}: "${c.message ?? "n/a"}" by ${c.author ?? "unknown"}, commit [${c.commit ?? "n/a"}]), `
    + `${p.hops} hop(s) from the alert: ${p.route.join(" -> ")}. Ask ${d.owner ?? "the service owner"}. `
    + `(Auto-generated from the graph because ${reason}. Confidence ${Number(top.conf).toFixed(2)}.)`;
  await TOOLS.save_explanation.run(ctx, { hypothesis_id: top.hid, explanation: text });
  return text;
}
