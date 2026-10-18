# Red String

**A detective board where AI agents solve production incidents by pinning evidence to a graph, and get faster with every case they close.**

Three AI agents split up when an alert fires. They never message each other. They read and write a shared FalkorDB graph, a red string snaps from the alert to the exact commit and the engineer who fixed the same kind of problem before, and every claim on screen links to the Cypher query that produced it. Resolve the incident and the graph remembers it, so the next similar incident is recalled from memory instead of investigated from scratch.

| | |
|---|---|
| Hackathon | Graph Hacks (FalkorDB x WeMakeDevs), October 15 to 18, 2026 |
| Tracks entered | **Agents That Act on Connected Data**, **Agent Memory and Coordination**, **Company Brain** |

---

## 1. The objective

When production breaks, the answer is scattered across systems that don't talk to each other: the service dependency map, the deploy log, git history, the on-call roster, old postmortems and runbooks. A human stitches it together under pressure. An AI agent has the same problem and a worse one: it sees fragments, forgets earlier incidents, and cannot show how it reached a conclusion.

Red String puts all of that context into one graph and makes the graph do the work:

- **Follow connections across data.** From the failing service, walk `DEPENDS_ON` edges to every service that could be responsible, and find the deploys that changed them.
- **Remember across sessions.** A resolved incident becomes edges (`ROOT_CAUSE`, `FIXED_BY`). The next incident finds it by structure, with no retraining and no vector store.
- **Share state between agents.** Hypotheses and evidence are nodes. Agents coordinate only by reading and writing them.
- **Connect people, projects and decisions.** The answer names who fixed this before, who owns the service, which runbook covers it and which decision was recorded in the postmortem.
- **Show the path behind every answer.** Every evidence card stores the Cypher that found it. Click it to see the query and its parameters.

## 2. What it does

You fire an alert on the board (for example "search p99 latency breach") and press **Run the agents**.

| Agent | Job | How it uses the graph |
|---|---|---|
| **Scout** | Find what changed near the failing service | Variable-length traversal from the alerting service through `DEPENDS_ON`, to deploys that `CHANGED` a service in that radius within the last hour |
| **Historian** | Be the team's memory | Matches the current incident to resolved ones by shared affected services, and reads their root cause, fix and who performed it |
| **Skeptic** | Break the other agents' theories | Reads which commit kinds have actually caused incidents before, and contradicts hypotheses that don't fit |
| **Narrator** | Explain the winning answer | Walks the shortest dependency path to the surviving hypothesis, and writes a short cited explanation |

On the board you watch the reasoning form as red strings between pinned cards: failing service, dependency route, deploys, commits, authors, hypotheses, and evidence post-its from each agent. The Skeptic stamps the decoy deploy **Ruled out**. The Narrator's answer appears with every id linked to its card.

**The memory moment.** Run "Search latency spike" first (the graph has never seen this kind of incident). Agents work from scratch. Click **Mark resolved**, choose who fixed it, and the graph writes the root cause and fix. Then run "Recommendations timing out", a similar but not identical incident. The Historian recalls the first case, verifies that the same pattern is present in the live blast radius, and Scout and Skeptic are skipped. The card is tagged *Recalled from memory*, the earlier case and its fixer are pinned to the board, and the on-screen clock shows the difference. All timings are measured and stored on the incident node in the graph.

## 3. Why the graph is essential, not decoration

Rule 3 asks that the product stop working if FalkorDB is removed. In Red String:

- **No blast radius.** Scout's only way to find candidate causes is a traversal over `DEPENDS_ON` and `CHANGED` edges.
- **No recall.** The Historian's only way to recognise a repeat is a structural match over `AFFECTED` and `ROOT_CAUSE` edges.
- **No coordination.** Agents have no other channel. Hypotheses and evidence live in the graph, and the Skeptic and Narrator read what Scout wrote there.
- **No earned confidence.** A hypothesis's confidence is computed by a Cypher query from the evidence edges attached to it. No agent can assert it.
- **No memory.** The learning loop is edges written when an incident is resolved.

In the UI, tick **Memory off** to run the same incident without the recall shortcut and compare the clock against the memory run.

## 4. How it covers each track

| Track | What in Red String covers it |
|---|---|
| **Agents That Act on Connected Data** | Agents traverse services, deploys, commits, alerts, people and runbooks to find the root cause, propose a fix path, and name who to ask |
| **Agent Memory and Coordination** | Agents share a Hypothesis/Evidence subgraph and coordinate only through it. Resolved incidents become memory the next run reuses, and the board shows when an answer was recalled |
| **Company Brain** | Services, ownership, deploys, people, postmortems, decisions and runbooks form one connected organisation graph. The answer cites all of them |

## 5. Architecture

```
 Browser (ui/index.html, GSAP animation)
    |  SSE event stream + JSON API
 Node server (src/server.ts) ---- snapshot.ts: builds the cards and strings from Cypher
    |
 Orchestrator (src/solve.ts) -- decides WHICH agents run, never WHAT they conclude
    |            \
    |             memory fast path: one recall query, verify pattern, skip Scout/Skeptic
 Agents (src/agents.ts): Gemini Interactions API, function calling
    |  every tool is a Cypher function (src/tools.ts)
 FalkorDB  <-- single source of truth: org data, memory, shared agent state
```

Agents talk to Gemini only to decide which tool to call next. Everything they know and everything they write goes through FalkorDB.

## 6. Graph data model

### Nodes

| Label | Key properties |
|---|---|
| `Service` | `name`, `layer` (edge, core, platform, data), `tier` |
| `Person` | `id`, `name`, `team` |
| `Deploy` | `id`, `ts`, `env` |
| `Commit` | `id`, `kind` (config, schema, copy, dep-bump, ...), `message`, `ts` |
| `Alert` | `id`, `name`, `metric`, `severity`, `ts` |
| `Incident` | `id`, `title`, `status`, `openedTs`, `resolvedTs`, `durationSec`, `answer`, `solveMs`, `solvePath` |
| `Action` | `id`, `type`, `text` (what fixed it) |
| `Postmortem`, `Decision` | `summary`; `text`, `ts` |
| `Runbook` | `id`, `title` |
| `Agent` | `name`, `role` (Scout, Historian, Skeptic, Narrator) |
| `Hypothesis` | `id`, `text`, `confidence`, `status` (open, rejected, confirmed), `explanation` |
| `Evidence` | `id`, `text`, `agent`, `stance`, `cypher` (the query that found it), `recalled` |

### Relationships

```
Organisation
(Service)-[:DEPENDS_ON]->(Service)          (Deploy)-[:CHANGED]->(Service)
(Commit)-[:PART_OF]->(Deploy)               (Person)-[:AUTHORED]->(Commit)
(Person)-[:OWNS]->(Service)                 (Runbook)-[:COVERS]->(Service)

Incidents and memory
(Alert)-[:FIRED_ON]->(Service)              (Incident)-[:TRIGGERED_BY]->(Alert)
(Incident)-[:AFFECTED]->(Service)           (Incident)-[:ROOT_CAUSE]->(Deploy|Commit)
(Incident)-[:FIXED_BY]->(Action)<-[:PERFORMED]-(Person)
(Incident)-[:DOCUMENTED_IN]->(Postmortem)-[:RECORDED]->(Decision)-[:MADE_BY]->(Person)
(Decision)-[:ABOUT]->(Service)              (Incident)-[:USED_RUNBOOK]->(Runbook)

Shared agent state
(Agent)-[:PROPOSED]->(Hypothesis)-[:EXPLAINS]->(Incident)
(Hypothesis)-[:IMPLICATES]->(Deploy)
(Evidence)-[:SUPPORTS|CONTRADICTS]->(Hypothesis)
(Evidence)-[:ABOUT]->(any node)             (Agent)-[:PINNED]->(Evidence)
```

The synthetic seed produces 740 nodes and 1,289 relationships. Indexes are created in `src/schema.ts`.

## 7. The queries and graph algorithms the product depends on

All agent tools live in `src/tools.ts`. The queries below are the ones that matter.

### 7.1 Scout: blast radius to recent changes

```cypher
MATCH p=(t:Service {name:$svc})-[:DEPENDS_ON*0..4]->(s:Service)<-[:CHANGED]-(d:Deploy)
WHERE d.ts > $ts - $windowMs AND d.ts <= $ts
WITH d, s, p ORDER BY length(p)
WITH d, s, collect(p)[0] AS best
RETURN d.id AS deploy, d.ts AS deployTs, s.name AS service, length(best) - 1 AS hops,
       [n IN nodes(best) | coalesce(n.name, n.id)] AS route
ORDER BY hops, deployTs DESC
```

**Graph algorithm:** bounded variable-length traversal over `DEPENDS_ON` (0 to 4 hops). Starting at the failing service it reaches everything the service depends on, then joins to deploys that changed those services before the alert. `collect(p)[0]` after ordering by path length keeps the shortest route when several dependency paths reach the same deploy. The `route` is what becomes the red string on the board.

### 7.2 Historian: memory by structural similarity

```cypher
MATCH (cur:Incident {id:$id})-[:AFFECTED]->(s:Service)<-[:AFFECTED]-(past:Incident {status:'resolved'})
WHERE past.id <> $id
WITH past, count(DISTINCT s) AS overlap
MATCH (past)-[:FIXED_BY]->(a:Action)<-[:PERFORMED]-(who:Person)
OPTIONAL MATCH (past)-[:ROOT_CAUSE]->(c:Commit)-[:PART_OF]->(:Deploy)-[:CHANGED]->(rs:Service)
RETURN past.id AS incident, past.title AS title, overlap, a.text AS fix, a.type AS fixType,
       who.name AS who, who.id AS whoId, rs.name AS rootService, c.kind AS rootKind,
       c.message AS rootMessage, past.durationSec AS humanSeconds
ORDER BY overlap DESC, past.openedTs DESC LIMIT 3
```

Past incidents are ranked by how many affected services they share with the current one. Overlap 1 is treated as weak, overlap 2 or more as a real match. The query also follows the graph from the past incident to its root-cause commit, the service that commit changed, the fix, and the person who performed it. Nothing is matched on text, so it works with no embeddings.

### 7.3 Memory fast path: verify the remembered pattern against the live graph

After recall, the orchestrator checks that the same pattern exists now: same changed service, same commit kind, inside the blast radius, before the alert.

```cypher
MATCH p=(t:Service {name:$svc})-[:DEPENDS_ON*0..4]->(s:Service {name:$root})<-[:CHANGED]-(d:Deploy)<-[:PART_OF]-(c:Commit {kind:$kind})
WHERE d.ts > $ts - 3600000 AND d.ts <= $ts
RETURN d.id AS deploy, c.id AS commit, c.message AS message, length(p) - 2 AS hops
ORDER BY hops, d.ts DESC
```

If a deploy matches, the orchestrator writes a hypothesis with evidence marked `recalled: true` and skips the Scout and Skeptic agents. If nothing matches, it falls back to the full investigation. Memory is never trusted blindly.

### 7.4 Skeptic: what has actually broken here before

```cypher
MATCH (cur:Incident {id:$id})-[:AFFECTED]->(s:Service)<-[:AFFECTED]-(past:Incident {status:'resolved'})-[:ROOT_CAUSE]->(c:Commit)
WHERE past.id <> $id
RETURN c.kind AS kind, count(DISTINCT past) AS incidents ORDER BY incidents DESC
```

A second query runs the same count across all resolved incidents. A commit kind that has never been a root cause (for example a copy tweak or a dependency bump) is evidence against the hypothesis that blames it.

### 7.5 Shared state: hypotheses and evidence

```cypher
MATCH (ag:Agent {name:$agent}), (i:Incident {id:$inc}), (d:Deploy {id:$deploy})
MERGE (h:Hypothesis {id:$hid})
ON CREATE SET h.text = $text, h.confidence = 0.3, h.status = 'open', h.live = true, h.ts = $ts
MERGE (ag)-[:PROPOSED]->(h) MERGE (h)-[:EXPLAINS]->(i) MERGE (h)-[:IMPLICATES]->(d)
```

The hypothesis id is `H-<incident>-<deploy>`, so two agents that blame the same deploy converge on one node instead of duplicating it. Evidence is created with a `SUPPORTS` or `CONTRADICTS` edge to the hypothesis, an `ABOUT` edge to the nodes it concerns, and the Cypher that produced it stored as a property.

### 7.6 Earned confidence

```cypher
MATCH (h:Hypothesis {id:$hid})
OPTIONAL MATCH (s:Evidence)-[:SUPPORTS]->(h)
WITH h, count(DISTINCT s) AS sup
OPTIONAL MATCH (c:Evidence)-[:CONTRADICTS]->(h)
WITH h, sup, count(DISTINCT c) AS con, 0.3 + 0.15 * sup - 0.4 * count(DISTINCT c) AS raw
SET h.confidence = CASE WHEN raw < 0.02 THEN 0.02 WHEN raw > 0.99 THEN 0.99 ELSE raw END,
    h.status = CASE WHEN h.status = 'confirmed' THEN 'confirmed'
                    WHEN con > 0 AND raw < 0.45 THEN 'rejected' ELSE 'open' END
RETURN h.confidence AS confidence, h.status AS status, sup AS supports, con AS contradictions
```

Confidence is a function of the graph. After every piece of evidence the score is recomputed from the edges. A contradicted hypothesis that is not clearly ahead is marked `rejected`, which is what produces the *Ruled out* stamp.

### 7.7 Narrator: the red string

```cypher
MATCH (t:Service {name:$from}), (s:Service {name:$to})
WITH shortestPath((t)-[:DEPENDS_ON*..6]->(s)) AS p
RETURN [n IN nodes(p) | n.name] AS route, length(p) AS hops
```

**Graph algorithm:** `shortestPath` over `DEPENDS_ON`. It gives the minimal dependency route from the failing service to the service the winning deploy changed, which the Narrator quotes and the board draws.

### 7.8 The learning loop (`src/resolve.ts`)

When you mark an incident resolved, the graph writes:

```cypher
MATCH (i:Incident {id:$id}), (d:Deploy {id:$did}), (p:Person {id:$who})
SET i.status = 'resolved', i.resolvedTs = $now, i.durationSec = toInteger(($now - i.openedTs) / 1000)
MERGE (i)-[:ROOT_CAUSE]->(d)
CREATE (i)-[:FIXED_BY]->(:Action {id:$aid, type:$type, text:$text, live:true})<-[:PERFORMED]-(p)
```

followed by `ROOT_CAUSE` edges to the deploy's commits, the hypothesis marked `confirmed`, and a `Postmortem` node. From that moment the query in 7.2 can find this incident.

### Not used
No vector index and no PageRank. They were cut deliberately: structural recall over typed edges was enough and is easier to explain.

## 8. Setup

### Prerequisites
- Node.js 20 or newer
- Docker (for local FalkorDB), or a FalkorDB Cloud instance
- A Gemini API key from https://aistudio.google.com/api-keys (not needed for simulated agents)

### Local setup

```bash
git clone [PUBLIC REPO URL] && cd redstring
npm install
cp .env.example .env          # optional, defaults work for local Docker
npm run up                    # FalkorDB on :6379 and the FalkorDB Browser on :3000
npm run seed                  # builds the synthetic organisation graph (deterministic)
export GEMINI_API_KEY=...     # use a secret in Codespaces; never commit a key
npm run ui                    # board on http://localhost:4000
```

In GitHub Codespaces, open port 4000 from the Ports tab. Port 3000 is the FalkorDB Browser, where you can run Cypher such as `MATCH (n) RETURN n LIMIT 150` against the `redstring` graph.

The scripts read environment variables from the shell. If you use `.env`, load it with `export $(cat .env | xargs)`.

### FalkorDB Cloud instead of Docker

```bash
export FALKORDB_URL='redis://default:PASSWORD@HOST:PORT'
npm run seed && npm run ui
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | none | Agent model access |
| `MODEL` | `gemini-3.5-flash,gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.8-flash` | Comma-separated model list. Free-tier quotas are per model, so an exhausted or missing model fails over to the next |
| `FALKORDB_URL` | none | Full URL (use for FalkorDB Cloud) |
| `FALKORDB_HOST` / `FALKORDB_PORT` | `localhost` / `6379` | Local connection |
| `GRAPH_NAME` | `redstring` | Graph key |
| `PORT` | `4000` | Board server port |

### Verify the install

```bash
npm run smoke
```

Needs a seeded FalkorDB and no API key. It exercises every agent tool, the full cold-then-memory loop with scripted agents, and the snapshot the board draws (20 checks).

### Command line equivalents

```bash
npm run arm -- search 1               # fire an incident (checkout | bus | search 1 | search 2)
npm run verify -- INC-18              # run the Scout and Historian queries directly
npm run solve -- INC-18               # run the agents (add --cold to turn memory off)
npm run resolve -- INC-18 --who marcus --text "Reverted flag and warmed cache" --type revert
npm run arm -- --reset                # remove all live demo data
```

### Troubleshooting
- **`ECONNREFUSED ::1:6379`**: FalkorDB isn't running. Run `npm run up`, wait a few seconds, then `npm run seed`.
- **429 or "limit: 20 requests per day"**: Gemini free-tier quota. The loop moves to the next model automatically. If all are exhausted, enable billing in Google AI Studio, or tick **Simulated agents** on the board.
- **`Missing script: "solve"`**: you have an older copy of `package.json`.

## 9. Using the board

1. Choose an incident and press **Fire alert**. Pins appear for the incident, the alert and the failing service.
2. Press **Run the agents**. Strings snap across the board as agents write edges. The right panel shows the live clock and every tool call. Click any log line, or any post-it, to open the drawer with the Cypher and parameters behind it.
3. Read the answer. Click an id chip to pulse the card and strings it refers to.
4. Press **Mark resolved**, choose who fixed it, and save. This is the write that creates memory.
5. Fire the similar incident and run again. Compare the clock, and look for the *Recalled from memory* tape.

**Memory off** forces the full investigation. **Simulated agents** plays scripted agents through the same tools and graph writes with no model calls. Simulated runs are labelled `sim` in the run history and are not a substitute for the real agents in the demo.

## 10. Data (rule 6)

All data is **synthetic**, generated by `src/data.ts` with a fixed seed so every run builds the same graph: 40 services in four layers, 12 fictional people, 215 deploys, 399 commits, 15 past incidents with causal chains, 15 postmortems, 2 decisions and 8 runbooks. No private, personal, login-protected or paywalled data is loaded.

The history contains two recurring patterns (a config change on a database proxy, and a schema change on a message bus) plus unrelated incidents as noise. A third pattern, a feature-flag change that causes a cache stampede, is deliberately absent from history, so it is the cold-start case. Each live scenario also plants a recent but innocent "decoy" deploy for the Skeptic to rule out.

## 11. Technical decisions

- **Agents coordinate only through the graph.** There is no message passing. A restarted agent re-reads its state from the graph instead of repeating work.
- **Confidence is computed, never asserted.** An LLM cannot talk itself into a high score.
- **The orchestrator decides which agents run, not what they conclude.** The memory shortcut is a graph query plus a verification query, not an LLM judgement.
- **Model calls are scarce, so agents are lean.** Tools return enriched rows (commits, owner, hops, timing) so agents need fewer round trips, and an agent stops once its graph writes are complete. A cold run takes about 8 model calls and a memory run about 2.
- **Resilience.** Model failover across a list, retries with backoff, empty-reply nudges, and a fallback that builds the answer from the graph if no model is available (clearly labelled as auto-generated).
- **Evidence stores its own Cypher.** That is what makes "show the path behind an answer" literal.

## 12. AI assistance disclosure

- **Coding assistant:** Claude (Anthropic) was used to help generate and iterate on code in this repository, including the seed generator, agent tools, orchestrator, server and UI.
- **Runtime models:** the agents call Google Gemini through the Interactions API for tool selection and writing explanations. Earlier iterations also tried Groq (`gpt-oss-120b`) and OpenRouter, and those are not in the final code.

## 13. Project structure

```
src/data.ts        synthetic organisation graph and past incidents
src/schema.ts      indexes
src/seed.ts        loads the graph with batched UNWIND queries
src/tools.ts       every agent tool, all Cypher (queries in section 7)
src/agents.ts      agent prompts, Gemini tool loop, model failover
src/solve.ts       orchestrator, memory fast path, safety nets
src/resolve.ts     the learning loop
src/arm.ts         fires demo incidents with timestamps relative to now
src/simulate.ts    scripted agents (labelled as simulated)
src/snapshot.ts    builds the investigation subgraph the board draws
src/server.ts      static files, JSON API, live event stream
src/smoke.ts       20-check test of tools, memory loop and snapshot
ui/index.html      the corkboard (GSAP red-string animation)
```

## 14. Limitations and next steps

- Single-tenant demo: one graph, one run at a time.
- Recall matches on affected services and root-cause pattern. A production version would add richer signals such as alert text embeddings, which FalkorDB's vector support could provide.
- The decoy deploys and the three incident scenarios are planted so the demo is deterministic.
- Free-tier model quotas limit how often the real agents can run. Billing removes the limit.

