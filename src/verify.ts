// Runs the Scout and Historian queries for an incident so you can sanity-check the planted patterns.
//   npm run verify -- INC-18
import { connect } from "./graph.js";
import { Q_BLAST, Q_RECALL } from "./tools.js";
const id = process.argv[2];
if (!id) { console.error("usage: verify <incident-id>"); process.exit(1); }
const { db, graph } = await connect();

const a = await graph.query(
  "MATCH (:Incident {id:$id})-[:TRIGGERED_BY]->(a:Alert)-[:FIRED_ON]->(t:Service) RETURN t.name AS svc, a.ts AS ts",
  { params: { id } });
const { svc, ts } = a.data![0] as { svc: string; ts: number };
console.log(`\nalert on ${svc}`);

console.log("\nSCOUT: recent changes in the blast radius");
const scout = await graph.query(Q_BLAST(4), { params: { svc, ts, windowMs: 3600000 } });
console.table(scout.data);

console.log("HISTORIAN: similar resolved incidents");
const hist = await graph.query(Q_RECALL, { params: { id } });
console.table(hist.data?.length ? hist.data : [{ result: "no match: cold start" }]);
await db.close();
