import { connect, type Graph } from "./graph.js";

// Indexes keep the MATCH-by-id lookups in seed/arm and the agent tools fast.
const INDEXES: [label: string, prop: string][] = [
  ["Service", "name"],
  ["Person", "id"],
  ["Deploy", "id"],
  ["Deploy", "ts"], // Scout's time-window filter
  ["Commit", "id"],
  ["Incident", "id"],
  ["Alert", "id"],
  ["Action", "id"],
  ["Runbook", "id"],
  ["Postmortem", "id"],
  ["Decision", "id"],
  ["Agent", "name"],
  ["Hypothesis", "id"],
  ["Evidence", "id"],
];

export async function createSchema(graph: Graph) {
  for (const [label, prop] of INDEXES) {
    try {
      await graph.query(`CREATE INDEX FOR (n:${label}) ON (n.${prop})`);
    } catch (e) {
      if (!/already indexed|already exists/i.test(String(e))) throw e;
    }
  }
  console.log(`indexes ready (${INDEXES.length})`);
}

if (process.argv[1]?.endsWith("schema.ts")) {
  const { db, graph } = await connect();
  // Indexes need the graph to exist; create a throwaway node if it doesn't.
  await graph.query("MERGE (:__init {k:1})");
  await createSchema(graph);
  await graph.query("MATCH (n:__init) DELETE n");
  await db.close();
}
