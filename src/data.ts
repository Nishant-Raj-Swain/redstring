// Deterministic synthetic data for RED STRING. Fully fake => safe under hackathon rule 6.
// Same seed => same graph, so the demo is repeatable.

export type Row = Record<string, string | number | boolean | string[]>;

const MIN = 60_000;
const DAY = 86_400_000;

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- services (40) ----------
const LAYERS: Record<string, string[]> = {
  edge: ["web-frontend", "mobile-bff", "api-gateway", "cdn-config"],
  core: ["checkout", "cart", "search", "catalog", "orders", "payments", "user-profile",
         "recommendations", "notifications", "inventory", "shipping", "pricing", "promotions", "reviews"],
  platform: ["auth", "db-proxy", "cache-layer", "message-bus", "feature-flags", "config-service",
             "rate-limiter", "session-store", "email-sender", "sms-gateway", "search-indexer",
             "image-service", "fraud-check", "tax-service"],
  data: ["postgres-orders", "postgres-users", "postgres-catalog", "redis-main", "kafka-main",
         "elasticsearch", "s3-assets", "clickhouse-analytics"],
};
const NEXT: Record<string, string> = { core: "platform", platform: "data" };
const TIER1 = new Set(["checkout", "payments", "orders", "api-gateway", "db-proxy", "postgres-orders", "auth"]);

// Hand-wired edges that make the planted scenarios deterministic.
// checkout -> orders -> inventory -> db-proxy        (3 hops)  pattern A, warm
// notifications -> message-bus                        (1 hop)   pattern C, warm
// search -> catalog -> cache-layer -> feature-flags   (3 hops)  pattern B, COLD (held out of history)
const FORCED: Record<string, string[]> = {
  "web-frontend": ["checkout", "search", "cart"],
  "mobile-bff": ["checkout", "search", "user-profile"],
  "api-gateway": ["auth", "rate-limiter", "checkout", "orders"],
  "cdn-config": ["web-frontend"],
  checkout: ["orders", "payments", "pricing"],
  orders: ["inventory", "message-bus", "shipping"],
  inventory: ["db-proxy", "session-store"],
  payments: ["fraud-check", "tax-service"],
  pricing: ["config-service", "rate-limiter"],
  cart: ["db-proxy", "session-store"],
  "user-profile": ["db-proxy", "auth"],
  search: ["catalog", "search-indexer"],
  catalog: ["cache-layer", "search-indexer"],
  recommendations: ["catalog", "session-store"],
  notifications: ["message-bus", "email-sender", "sms-gateway"],
  shipping: ["message-bus"],
  "cache-layer": ["feature-flags", "redis-main"],
  "message-bus": ["kafka-main", "config-service"],
  "db-proxy": ["postgres-orders", "postgres-users", "postgres-catalog"],
  "search-indexer": ["elasticsearch"],
};

// ---------- people (12) ----------
const PEOPLE: [id: string, name: string, team: string][] = [
  ["priya", "Priya Nair", "platform"], ["marcus", "Marcus Chen", "platform"],
  ["lena", "Lena Fischer", "data-infra"], ["dev", "Dev Patel", "payments"],
  ["sofia", "Sofia Alvarez", "commerce"], ["tom", "Tom Becker", "commerce"],
  ["aisha", "Aisha Khan", "media"], ["jonas", "Jonas Weber", "platform"],
  ["mei", "Mei Tanaka", "identity"], ["carlos", "Carlos Ruiz", "logistics"],
  ["hannah", "Hannah Cole", "growth"], ["omar", "Omar Said", "data-infra"],
];
const FORCED_OWNER: Record<string, string> = {
  "db-proxy": "priya", "cache-layer": "marcus", "feature-flags": "marcus",
  "message-bus": "lena", checkout: "sofia", pricing: "tom",
};

// ---------- commit flavour ----------
const KIND_WEIGHTS: [string, number][] = [
  ["feature", 30], ["bugfix", 25], ["dep-bump", 15], ["refactor", 10], ["copy", 10], ["config", 7], ["schema", 3],
];
const MSG: Record<string, string[]> = {
  feature: ["add retry budget to client", "ship v2 endpoint behind flag", "support bulk operations"],
  bugfix: ["fix off-by-one in pagination", "handle null address", "fix race in token refresh"],
  "dep-bump": ["bump http client minor", "bump logging lib", "update base image"],
  refactor: ["split handler into modules", "extract validation layer", "tidy error mapping"],
  copy: ["update banner copy", "fix typo in email template", "rename button label"],
  config: ["tune timeouts", "adjust worker count", "change log level"],
  schema: ["add nullable column", "add index", "add optional event field"],
};

// ---------- incidents ----------
type Spec = {
  id: string; title: string; alertService: string; metric: string; affected: string[];
  rootService: string; kind: string; rootMsg: string;
  actionType: string; actionText: string; who: string; runbook?: string;
};
const A = "Rolled back db-proxy config deploy";
const C = "Reverted schema change and replayed events";
const SPECS: Spec[] = [
  // Pattern A (warm): config change on db-proxy starves the pool; fix = rollback; ask Priya
  { id: "INC-04", title: "Orders API timeouts after DB config change", alertService: "orders", metric: "error_rate",
    affected: ["checkout", "orders", "inventory"], rootService: "db-proxy", kind: "config",
    rootMsg: "db-proxy: tune pool_size 100 -> 40", actionType: "rollback", actionText: A, who: "dev", runbook: "R-01" },
  { id: "INC-11", title: "Checkout latency spike", alertService: "checkout", metric: "p99_latency",
    affected: ["checkout", "orders"], rootService: "db-proxy", kind: "config",
    rootMsg: "db-proxy: idle_timeout 30s -> 5s", actionType: "rollback", actionText: A, who: "priya", runbook: "R-01" },
  { id: "INC-17", title: "Checkout errors: DB connections exhausted", alertService: "checkout", metric: "error_rate",
    affected: ["checkout", "orders", "inventory"], rootService: "db-proxy", kind: "config",
    rootMsg: "db-proxy: lower pool_size 120 -> 30", actionType: "rollback", actionText: A, who: "priya", runbook: "R-01" },
  // Pattern C (warm): schema change on message-bus breaks consumers; fix = revert + replay; ask Lena
  { id: "INC-08", title: "Order confirmation emails delayed", alertService: "notifications", metric: "consumer_lag",
    affected: ["notifications", "message-bus"], rootService: "message-bus", kind: "schema",
    rootMsg: "message-bus: rename order_event.total field", actionType: "revert", actionText: C, who: "lena", runbook: "R-03" },
  { id: "INC-12", title: "Orders stuck in pending", alertService: "orders", metric: "queue_depth",
    affected: ["orders", "message-bus", "notifications"], rootService: "message-bus", kind: "schema",
    rootMsg: "message-bus: split order_event into v2", actionType: "revert", actionText: C, who: "lena", runbook: "R-03" },
  { id: "INC-15", title: "Shipping updates not delivered", alertService: "shipping", metric: "consumer_lag",
    affected: ["shipping", "message-bus"], rootService: "message-bus", kind: "schema",
    rootMsg: "message-bus: drop legacy shipment_event fields", actionType: "revert", actionText: C, who: "omar", runbook: "R-03" },
  // Noise: unrelated history so the Historian has to rank, not just return everything.
  // Pattern B (cache stampede after a feature-flag change) is deliberately NOT here: it's the cold-start demo.
  { id: "INC-03", title: "Payment provider timeouts", alertService: "payments", metric: "p99_latency", affected: ["checkout", "payments"],
    rootService: "payments", kind: "dep-bump", rootMsg: "payments: bump http client 4.2 -> 4.3", actionType: "pin", actionText: "Pinned http client to 4.2", who: "tom" },
  { id: "INC-05", title: "Image resizing out of memory", alertService: "image-service", metric: "oom_kills", affected: ["image-service", "catalog"],
    rootService: "image-service", kind: "feature", rootMsg: "image-service: add webp variants", actionType: "rollback", actionText: "Rolled back deploy", who: "aisha" },
  { id: "INC-06", title: "Login failures spike", alertService: "auth", metric: "error_rate", affected: ["auth", "user-profile"],
    rootService: "auth", kind: "bugfix", rootMsg: "auth: fix token refresh race", actionType: "hotfix", actionText: "Hotfix forward: patched token refresh", who: "mei" },
  { id: "INC-07", title: "Shipping label API errors", alertService: "shipping", metric: "error_rate", affected: ["shipping", "orders"],
    rootService: "shipping", kind: "dep-bump", rootMsg: "shipping: bump carrier SDK", actionType: "pin", actionText: "Pinned carrier SDK", who: "carlos" },
  { id: "INC-09", title: "Search results stale", alertService: "search", metric: "freshness_lag", affected: ["search", "search-indexer"],
    rootService: "search-indexer", kind: "refactor", rootMsg: "search-indexer: batch writer refactor", actionType: "reindex", actionText: "Re-ran full reindex", who: "hannah", runbook: "R-05" },
  { id: "INC-10", title: "Promo codes rejected", alertService: "promotions", metric: "error_rate", affected: ["promotions", "checkout"],
    rootService: "promotions", kind: "bugfix", rootMsg: "promotions: fix stacking rule", actionType: "hotfix", actionText: "Hotfix forward: corrected stacking rule", who: "sofia" },
  { id: "INC-13", title: "Cart totals mismatch", alertService: "pricing", metric: "correctness", affected: ["pricing", "cart"],
    rootService: "pricing", kind: "feature", rootMsg: "pricing: tax rounding change", actionType: "rollback", actionText: "Rolled back deploy", who: "tom" },
  { id: "INC-14", title: "Gateway upstream 5xx", alertService: "api-gateway", metric: "error_rate", affected: ["api-gateway", "web-frontend"],
    rootService: "api-gateway", kind: "config", rootMsg: "api-gateway: tighten upstream timeout", actionType: "rollback", actionText: "Rolled back config", who: "priya" },
  { id: "INC-16", title: "Review submissions failing", alertService: "reviews", metric: "error_rate", affected: ["reviews", "user-profile"],
    rootService: "reviews", kind: "schema", rootMsg: "reviews: add moderation column", actionType: "migrate", actionText: "Ran missing migration", who: "marcus" },
];

const RUNBOOKS: [id: string, title: string, covers: string[]][] = [
  ["R-01", "DB proxy pool exhaustion", ["db-proxy", "postgres-orders"]],
  ["R-02", "Cache stampede after flag-driven TTL changes", ["cache-layer", "feature-flags", "redis-main"]],
  ["R-03", "Message bus consumer lag", ["message-bus", "kafka-main", "notifications"]],
  ["R-04", "Checkout degradation triage", ["checkout", "orders", "payments"]],
  ["R-05", "Search freshness and latency", ["search", "search-indexer", "elasticsearch"]],
  ["R-06", "Auth and session incidents", ["auth", "session-store", "user-profile"]],
  ["R-07", "Third-party provider timeouts", ["payments", "shipping", "tax-service", "email-sender", "sms-gateway"]],
  ["R-08", "Rolling back a config deploy", ["config-service", "api-gateway", "db-proxy", "feature-flags"]],
];

const AGENTS: [name: string, role: string][] = [
  ["Scout", "blast-radius traversal from alert to recent changes"],
  ["Historian", "structural recall of resolved incidents"],
  ["Skeptic", "hunts contradicting evidence"],
  ["Narrator", "walks the winning path and explains it"],
];

export function generate(now = Date.now(), seed = 42) {
  const rand = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];
  const sample = <T,>(a: T[], n: number) => {
    const c = [...a]; const out: T[] = [];
    while (out.length < n && c.length) out.push(c.splice(Math.floor(rand() * c.length), 1)[0]);
    return out;
  };
  const hex = () => Array.from({ length: 7 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
  const weighted = () => {
    let r = rand() * KIND_WEIGHTS.reduce((s, [, w]) => s + w, 0);
    for (const [k, w] of KIND_WEIGHTS) { if ((r -= w) < 0) return k; }
    return "feature";
  };
  const peopleIds = PEOPLE.map((p) => p[0]);

  // services + dependencies
  const services: Row[] = [];
  const layerOf: Record<string, string> = {};
  for (const [layer, names] of Object.entries(LAYERS))
    for (const name of names) {
      layerOf[name] = layer;
      services.push({ name, layer, tier: TIER1.has(name) ? 1 : layer === "core" ? 2 : 3 });
    }
  const deps: Row[] = [];
  for (const s of services) {
    const name = s.name as string;
    let targets = FORCED[name];
    if (!targets && NEXT[layerOf[name]]) {
      const pool = LAYERS[NEXT[layerOf[name]]].filter((n) => n !== "db-proxy"); // keep hop counts deterministic
      targets = sample(pool, layerOf[name] === "core" ? 2 : 1);
    }
    for (const to of targets ?? []) deps.push({ from: name, to });
  }
  const owns: Row[] = services.map((s) => ({
    person: FORCED_OWNER[s.name as string] ?? pick(peopleIds), service: s.name as string,
  }));
  const ownerOf = Object.fromEntries(owns.map((o) => [o.service as string, o.person as string]));

  // background deploys: 200 over ~6 months, none in the last 24h so the live window is clean
  const rawDeploys = Array.from({ length: 200 }, () => ({
    ts: Math.floor(now - DAY - rand() * 179 * DAY),
    service: pick(services).name as string,
  })).sort((a, b) => a.ts - b.ts);
  const deploys: Row[] = []; const commits: Row[] = [];
  const addCommit = (deploy: string, author: string, kind: string, message: string, ts: number) =>
    commits.push({ id: `C-${hex()}`, deploy, author, kind, message, ts });
  rawDeploys.forEach((d, i) => {
    const id = `D-${612 + i}`; // background ids end at D-811, so the live culprit is D-812
    deploys.push({ id, ts: d.ts, env: "prod", service: d.service });
    for (let c = 0; c < int(1, 3); c++) {
      const kind = weighted();
      addCommit(id, rand() < 0.8 ? ownerOf[d.service] : pick(peopleIds), kind, `${d.service}: ${pick(MSG[kind])}`, d.ts - int(5, 90) * MIN);
    }
  });

  // past incidents with their full causal chain
  const incidents: Row[] = [], alerts: Row[] = [], affected: Row[] = [], rootCauses: Row[] = [],
    actions: Row[] = [], postmortems: Row[] = [], runbookUse: Row[] = [];
  for (const sp of SPECS) {
    const n = Number(sp.id.slice(4));
    const openedTs = Math.floor(now - (18 - n) * 9 * DAY - int(0, 6) * 3_600_000);
    const durationSec = int(1800, 6000); // how long humans took
    const dId = `D-${400 + n}`;
    const author = pick(peopleIds.filter((p) => p !== sp.who));
    const commitIdx = commits.length;
    deploys.push({ id: dId, ts: openedTs - int(5, 40) * MIN, env: "prod", service: sp.rootService });
    addCommit(dId, author, sp.kind, sp.rootMsg, openedTs - int(41, 60) * MIN);
    incidents.push({ id: sp.id, title: sp.title, status: "resolved", openedTs, resolvedTs: openedTs + durationSec * 1000, durationSec });
    alerts.push({ id: `AL-${n}`, incident: sp.id, service: sp.alertService, name: `${sp.alertService} ${sp.metric} breach`, metric: sp.metric, severity: "page", ts: openedTs });
    for (const s of sp.affected) affected.push({ incident: sp.id, service: s });
    rootCauses.push({ incident: sp.id, deploy: dId, commit: commits[commitIdx].id as string });
    actions.push({ id: `ACT-${n}`, incident: sp.id, who: sp.who, type: sp.actionType, text: sp.actionText });
    postmortems.push({ id: `PM-${n}`, incident: sp.id, title: `Postmortem: ${sp.title}`, summary: `Root cause: ${sp.rootMsg}. Fix: ${sp.actionText}.` });
    if (sp.runbook) runbookUse.push({ incident: sp.id, runbook: sp.runbook });
  }
  const decisions: Row[] = [
    { id: "DEC-01", postmortem: "PM-17", who: "priya", service: "db-proxy", text: "Gate db-proxy pool_size changes behind a canary", ts: now - 8 * DAY },
    { id: "DEC-02", postmortem: "PM-15", who: "lena", service: "message-bus", text: "Require a consumer-compat check for message-bus schema changes", ts: now - 27 * DAY },
  ];

  return {
    people: PEOPLE.map(([id, name, team]) => ({ id, name, team })) as Row[],
    services, deps, owns, deploys, commits, incidents, alerts, affected, rootCauses, actions,
    postmortems, decisions, runbookUse,
    runbooks: RUNBOOKS.map(([id, title]) => ({ id, title })) as Row[],
    covers: RUNBOOKS.flatMap(([runbook, , cs]) => cs.map((service) => ({ runbook, service }))) as Row[],
    agents: AGENTS.map(([name, role]) => ({ name, role })) as Row[],
  };
}
