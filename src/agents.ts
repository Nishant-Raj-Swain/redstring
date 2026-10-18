import { GoogleGenAI } from "@google/genai";
import type { Graph } from "./graph.js";
import { TOOLS, q, Q_BLAST, Q_INCIDENT, type Ctx, type Rec } from "./tools.js";
import type { Emit } from "./events.js";

// Comma-separated list. Free-tier quotas are PER MODEL, so when one is exhausted (or doesn't exist) we move to the next.
export const MODELS = (process.env.MODEL ?? "gemini-3.5-flash,gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.8-flash")
  .split(",").map((s) => s.trim()).filter(Boolean);
const dead = new Set<string>();
let client: GoogleGenAI | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LlmUnavailableError extends Error {}
class ModelUnavailable extends Error { constructor(public model: string, why: string) { super(why); } }

type AgentSpec = {
  name: string; system: string; tools: string[]; maxTurns: number;
  // Checked after every round that wrote to the graph: when true the agent's job is done and we skip the closing model call.
  done?: (graph: Graph, incidentId: string) => Promise<boolean>;
};

const SHARED = `You are one agent in a team solving a production incident. You cannot talk to the other agents.
The only way to coordinate is the shared graph: read Hypothesis/Evidence nodes with list_hypotheses and write with
propose_hypothesis / add_evidence. Every claim must be a concrete graph fact with ids (deploy ids like D-812, commit ids like C-1a2b3c4,
incident ids like INC-17, service names). Never invent ids; use only ids returned by tools. Confidence is computed from the evidence in
the graph, you cannot set it. Model calls are scarce: call every independent tool in the SAME turn, write everything you have in ONE round, no filler text.`;

const scalar = async (graph: Graph, cypher: string, params: Rec) => Number((await q(graph, cypher, params))[0]?.c ?? 0);

export const AGENTS: Record<string, AgentSpec> = {
  Scout: {
    name: "Scout", maxTurns: 5,
    tools: ["blast_radius_changes", "propose_hypothesis", "add_evidence"],
    system: `${SHARED}
ROLE: Scout. Find what changed near the failing service.
Turn 1: call blast_radius_changes (it already returns commits, owner, hops, route and minutes before the alert for each deploy).
Turn 2: for EVERY candidate deploy (max 4) call propose_hypothesis ONCE, passing 2-3 supporting "evidence" items in that same call: hop distance with the route,
timing relative to the alert, the commit kind and message with its author. Pin each item with "about" refs (Deploy, Commit, Service nodes).
Do not dismiss candidates, the Skeptic will challenge them. Then stop.`,
    async done(graph, id) {
      const [inc] = await q(graph, Q_INCIDENT, { id });
      const cands = (await q(graph, Q_BLAST(4), { svc: inc.alertService, ts: inc.alertTs, windowMs: 3_600_000 })).length;
      const have = await scalar(graph, "MATCH (h:Hypothesis)-[:EXPLAINS]->(:Incident {id:$id}) MATCH (:Evidence {agent:'Scout'})-[:SUPPORTS|CONTRADICTS]->(h) RETURN count(DISTINCT h) AS c", { id });
      return have >= Math.min(4, Math.max(1, cands));
    },
  },
  Historian: {
    name: "Historian", maxTurns: 4,
    tools: ["get_incident", "recall_similar_incidents", "past_incident_detail", "list_hypotheses", "add_evidence"],
    system: `${SHARED}
ROLE: Historian. You are the team's memory.
Turn 1: call recall_similar_incidents and list_hypotheses together. Overlap 1 is weak (one shared service); overlap >= 2 is a real structural match.
Turn 2: if a strong match's root-cause pattern (service and commit kind) fits a current hypothesis, add_evidence "supports" citing the past incident id, the fix and who performed it, with "about" refs to that Incident.
If all matches are weak or nothing fits, add nothing and say so in one line. Never force a match.`,
  },
  Skeptic: {
    name: "Skeptic", maxTurns: 4,
    tools: ["list_hypotheses", "root_cause_kind_stats", "add_evidence"],
    system: `${SHARED}
ROLE: Skeptic. Break the other agents' hypotheses with facts.
Turn 1: call list_hypotheses and root_cause_kind_stats together (hypotheses already include commit kind/message, hops and minutes before the alert).
Turn 2: in ONE round call add_evidence for EVERY hypothesis: stance "contradicts" with a concrete fact if it is cosmetic or unlikely
(commit kind has never caused an incident here, copy/dependency bump with no behavioural change, deployed after the alert, only loosely connected),
otherwise stance "supports" explaining which checks it survived. Contradict only with a real fact; confidence is earned, not guessed.`,
    async done(graph, id) {
      const [row] = await q(graph,
        `MATCH (h:Hypothesis)-[:EXPLAINS]->(:Incident {id:$id}) OPTIONAL MATCH (e:Evidence {agent:'Skeptic'})-[:SUPPORTS|CONTRADICTS]->(h)
         WITH h, count(e) AS c WHERE c = 0 RETURN count(h) AS missing`, { id });
      const total = await scalar(graph, "MATCH (h:Hypothesis)-[:EXPLAINS]->(:Incident {id:$id}) RETURN count(h) AS c", { id });
      return total > 0 && Number(row?.missing ?? 0) === 0;
    },
  },
  Narrator: {
    name: "Narrator", maxTurns: 4,
    tools: ["case_summary", "save_explanation"],
    system: `${SHARED}
ROLE: Narrator. Explain the winning answer.
Turn 1: call case_summary (best hypothesis, evidence, route, commits, owner, runbooks, recalled incidents and rejected hypotheses are all in it).
Turn 2: write at most 90 words and call save_explanation with them and the best hypothesis id: what broke, the exact route from the alert (use arrows),
the deploy and commit, which past incident it matches and what fixed it (only if recalledIncidents is non-empty), who to ask (the person who fixed it before, else the owner),
the runbook title, and one clause on what the Skeptic ruled out. Cite ids in [square brackets]. Never guess ids.`,
    async done(graph, id) { return !!(await q(graph, "MATCH (i:Incident {id:$id}) RETURN i.answer AS a", { id }))[0]?.a; },
  },
};

const summarize = (r: unknown) =>
  Array.isArray(r) ? `${r.length} rows` : r && typeof r === "object" ? JSON.stringify(r).slice(0, 110) : String(r);

const textOfSteps = (it: Rec): string =>
  (it.output_text as string | undefined) ??
  (it.steps ?? []).filter((st: Rec) => st.type === "model_output")
    .flatMap((st: Rec) => (st.content ?? []).filter((c: Rec) => c.type === "text").map((c: Rec) => c.text ?? "")).join("");

function classify(e: any): "quota" | "missing" | "retry" {
  const status = e?.status ?? e?.statusCode, msg = String(e?.message ?? e);
  if (status === 404) return "missing";
  if (status === 429) return /per day|daily|perday|retry in \d+h/i.test(msg) ? "quota" : "retry";
  return "retry";
}
function retryDelayMs(e: any, attempt: number): number {
  const m = /retry in (?:(\d+)m)?\s*(\d+(?:\.\d+)?)s/i.exec(String(e?.message ?? e));
  if (m) return Math.min(60_000, (Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000 + 500);
  return 1500 * 2 ** attempt;
}

type Progress = { tools: number };

async function runOnModel(model: string, spec: AgentSpec, prompt: string, graph: Graph, incidentId: string, emit: Emit, progress: Progress): Promise<string> {
  const ctx: Ctx = { graph, incidentId, agent: spec.name };
  const tools = spec.tools.map((n) => TOOLS[n]).map((t) => ({
    type: "function" as const, name: t.name, description: t.description,
    // Gemini rejects an OBJECT schema with empty properties, so tools without arguments declare no parameters
    ...(Object.keys(t.input_schema.properties ?? {}).length ? { parameters: t.input_schema } : {}),
  }));
  let input: unknown = prompt;
  let previousId: string | undefined;
  let nudges = 0;

  for (let turn = 0; turn < spec.maxTurns + 2; turn++) {
    let it: Rec | undefined;
    for (let attempt = 0; attempt < 5 && !it; attempt++) {
      try {
        it = await (client!.interactions as any).create({
          model, input, tools, system_instruction: spec.system,
          ...(previousId ? { previous_interaction_id: previousId } : {}),
        }) as Rec;
      } catch (e) {
        const kind = classify(e);
        if (kind !== "retry") throw new ModelUnavailable(model, kind === "quota" ? `${model} is out of daily quota` : `${model} was not found`);
        emit({ agent: spec.name, type: "error", message: `model call failed (attempt ${attempt + 1}): ${String(e).slice(0, 140)}` });
        if (attempt === 4) throw e;
        await sleep(retryDelayMs(e, attempt));
      }
    }
    previousId = it!.id ?? previousId;
    const calls: Rec[] = (it!.steps ?? []).filter((st: Rec) => st.type === "function_call");
    const text = textOfSteps(it!).trim();

    if (!calls.length) {
      if (!text) {
        if (nudges++ < 2) {
          emit({ agent: spec.name, type: "error", message: "empty reply, nudging" });
          input = "Your last reply was empty. Continue: call the next tool you need, or give your final answer as plain text.";
          continue;
        }
        return "";
      }
      emit({ agent: spec.name, type: "text", text });
      return text;
    }

    const results: Rec[] = [];
    let wrote = false;
    for (const c of calls) { // sequential: writes to the same hypothesis must not race
      const args: Rec = c.arguments ?? {};
      emit({ agent: spec.name, type: "tool", name: c.name, input: args });
      progress.tools++;
      let content: string, isError = false;
      try {
        const tool = TOOLS[c.name];
        if (!tool || !spec.tools.includes(c.name)) throw new Error(`unknown tool ${c.name}`);
        const out = await tool.run(ctx, args);
        if (out.write) wrote = true;
        if (out.cypher && !out.write) ctx.lastRead = { cypher: out.cypher, params: out.params ?? {} };
        emit({ agent: spec.name, type: "result", name: c.name, summary: summarize(out.result), cypher: out.cypher, params: out.params, write: !!out.write, data: out.result });
        content = JSON.stringify(out.result).slice(0, 6000);
      } catch (e) {
        emit({ agent: spec.name, type: "error", message: `${c.name}: ${String(e).slice(0, 200)}` });
        content = `Error: ${String(e)}`; isError = true;
      }
      results.push({ type: "function_result", name: c.name, call_id: c.id, result: [{ type: "text", text: content }], ...(isError ? { is_error: true } : {}) });
    }
    // The graph already holds this agent's output, so skip the closing model call (saves quota and seconds).
    if (wrote && spec.done && (await spec.done(graph, incidentId))) return "(done)";
    input = results;
  }
  return "(max turns reached)";
}

export async function runAgent(name: keyof typeof AGENTS, prompt: string, graph: Graph, incidentId: string, emit: Emit) {
  client ??= new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    ...(process.env.GEMINI_BASE_URL ? { httpOptions: { baseUrl: process.env.GEMINI_BASE_URL } } : {}),
  });
  const spec = AGENTS[name];
  const progress: Progress = { tools: 0 };
  let resume = "";
  for (const model of MODELS) {
    if (dead.has(model)) continue;
    try {
      return await runOnModel(model, spec, prompt + resume, graph, incidentId, emit, progress);
    } catch (e) {
      if (!(e instanceof ModelUnavailable)) throw e;
      dead.add(model);
      const next = MODELS.find((m) => !dead.has(m));
      emit({ agent: spec.name, type: "error", message: `${e.message}${next ? `, switching to ${next}` : ""}` });
      // Restarting is safe because the graph holds the state: the agent re-reads it instead of repeating work.
      if (progress.tools > 0) resume = "\n\nYou are resuming after an interruption. Call list_hypotheses first and do not duplicate evidence that is already pinned.";
    }
  }
  throw new LlmUnavailableError(`All configured models are out of quota or unavailable (${MODELS.join(", ")}). Enable billing in Google AI Studio, add more models to MODEL, or use Simulate.`);
}
