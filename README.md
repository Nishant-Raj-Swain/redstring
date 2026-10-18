# Red String

A detective board where AI agents solve production incidents by pinning evidence to a graph, and get faster with every case they close.

FalkorDB is the agents' working memory. Scout, Historian, Skeptic and Narrator never message each other: they coordinate only by reading and writing Hypothesis and Evidence nodes. Remove FalkorDB and there is no blast radius, no recall, and no coordination.

Tracks: Agents That Act on Connected Data, Agent Memory and Coordination, Company Brain.

## Run it

```bash
npm install
cp .env.example .env              # optional; defaults work for local Docker
npm run up                        # FalkorDB on :6379, FalkorDB Browser on :3000
npm run seed                      # synthetic company graph (deterministic)
export GEMINI_API_KEY=...         # aistudio.google.com/api-keys (use a Codespaces secret)
npm run ui                        # corkboard on http://localhost:4000 (Codespaces: Ports tab, 4000)
```

In the board: pick an incident, **Fire alert**, **Run the agents**. For the memory moment run "Search latency spike" first (the graph has never seen it), click **Mark resolved**, then run "Recommendations timing out" (similar, not identical). Click any post-it or any line in the agent log to see the exact Cypher behind it.

No API key or out of quota? Tick **Simulated agents**. They play the same roles through the same tools and graph writes, and every run is labelled simulated.

CLI equivalents: `npm run arm -- search 1`, `npm run solve -- INC-18` (add `--cold` for memory off), `npm run resolve -- INC-18 --who marcus`, `npm run arm -- --reset`.

`npm run smoke` checks every tool, the whole memory loop and the data the board draws (needs a seeded FalkorDB, no API key).

### Models and quota
`MODEL` is a comma-separated list (default `gemini-3.5-flash,gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.8-flash`). Free-tier quotas are per model, so when one is exhausted or missing the agent restarts on the next and re-reads its state from the graph. A cold run costs roughly 8 model calls, a memory run 2. If no model is available the Narrator's answer is built straight from the graph and labelled as such.

## Graph data model

```
(Service)-[:DEPENDS_ON]->(Service)            (Deploy)-[:CHANGED]->(Service)
(Commit)-[:PART_OF]->(Deploy)                 (Person)-[:AUTHORED]->(Commit)
(Person)-[:OWNS]->(Service)                   (Alert)-[:FIRED_ON]->(Service)
(Incident)-[:TRIGGERED_BY]->(Alert)           (Incident)-[:AFFECTED]->(Service)
(Incident)-[:ROOT_CAUSE]->(Deploy|Commit)     (Incident)-[:FIXED_BY]->(Action)<-[:PERFORMED]-(Person)
(Incident)-[:DOCUMENTED_IN]->(Postmortem)-[:RECORDED]->(Decision)-[:MADE_BY]->(Person)
(Incident)-[:USED_RUNBOOK]->(Runbook)-[:COVERS]->(Service)
(Agent)-[:PROPOSED]->(Hypothesis)-[:EXPLAINS]->(Incident)    (Hypothesis)-[:IMPLICATES]->(Deploy)
(Evidence)-[:SUPPORTS|CONTRADICTS]->(Hypothesis)             (Evidence)-[:ABOUT]->(any node)   (Agent)-[:PINNED]->(Evidence)
```

Synthetic data only: 40 services, 12 people, 215 deploys, 399 commits, 15 past incidents with root cause, fix, postmortem and runbook.

## The queries the product runs on (`src/tools.ts`)

- **Scout, blast radius to recent changes**: variable-length `DEPENDS_ON*0..4` from the alerting service to deploys that `CHANGED` something in that radius, shortest path kept per deploy.
- **Historian, memory by structural similarity**: past resolved incidents that `AFFECTED` the same services, ranked by overlap, joined to the root-cause commit kind, the fix and who performed it.
- **Skeptic, what has actually broken before**: root-cause commit kinds across incidents touching the same services and across all history.
- **Shared state**: `propose_hypothesis` MERGEs one Hypothesis per deploy, so two agents on the same deploy converge on one node; `add_evidence` pins evidence and the graph recomputes confidence (0.3 base, +0.15 per support, -0.4 per contradiction). No agent can assert confidence.
- **Learning loop** (`src/resolve.ts`): resolving writes `ROOT_CAUSE` and `FIXED_BY` edges, so the next Historian query finds the case. No retraining.
- **The red string**: `shortestPath((alert service)-[:DEPENDS_ON*..6]->(changed service))`.

Each piece of evidence stores the Cypher that produced it, which is what the board shows on click.

## Layout
`src/data.ts` seed data, `src/tools.ts` agent tools (all Cypher), `src/agents.ts` agent loops and model failover, `src/solve.ts` orchestrator and memory fast path, `src/snapshot.ts` + `src/server.ts` + `ui/index.html` the board.

## AI assistance disclosure
Built with Claude (Anthropic) as a coding assistant. Agents at runtime use Google Gemini. Replace this paragraph with what you personally designed, wrote and verified; judges may ask you to explain the graph model and every query.
