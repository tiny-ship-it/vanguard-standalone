# Hermes Integration — Vanguard Side

**Status:** Active
**Started:** 2026-05-28
**Sibling spec:** [`tinywins-assistant/projects/hermes-integration/SPEC.md`](https://github.com/tiny-ship-it/tinywins-assistant/blob/feat/hermes-week-1/projects/hermes-integration/SPEC.md)

This document is the Vanguard-side mirror of the Hermes integration spec. The full spec lives in the Tiny repo (link above) — read that first for the strategic frame, the eleven steal items, and the do-NOT-steal list. This file is scoped to the Vanguard-specific cuts: what changes in `vanguard-standalone`, when, and why.

---

## 1. What's already in Vanguard

Three pieces of Hermes thinking are already in this repo as of 2026-05-26:

- **Supervisor pattern** — `lib/core/supervisor.js` classifies agent outputs into `[ACK]/[ESCALATE]/[RETRY]/[SKIP]` intent markers. Ported from `tinywins-assistant/lib/flux-supervisor.js`. Verified by `harness/test-supervisor.js`. Lives on `feat/hermes-rebase`.
- **SSO-based tenant resolution** — `lib/tenant-resolver.js` resolves corporate identity (`corporate-{email}`) above Slack ID, established 2026-05-11.
- **Hardened Slack bridge** — `scripts/slack-bridge.js` exposes `/health` on port 3002, established 2026-05-20.

This spec is **additive** to those. Nothing here re-proposes them.

## 2. What Vanguard takes from Hermes (Week 1)

| File | What | Why Vanguard cares |
| --- | --- | --- |
| `lib/core/marker-blocks.js` | Managed markdown sections that self-heal. `read`/`upsert`/`remove`. Atomic writes, duplicate-name collapse | Vanguard writes per-tenant state at `vault/tenants/{id}/` and per-tenant notes/summaries. Same pattern, same need: machine writers must not trample human writers |
| `lib/core/skill-frontmatter.js` | agentskills.io-compatible parser + indexer + ranker | Vanguard's tenant skills live at `vault/tenants/{id}/skills/`. Multi-tenant skill loading needs to gate on metadata; agentskills.io is the open standard a tenant can bring skills from |
| `scripts/vanguard-doctor.js` | Vanguard-shaped health command | Slack bridge `:3002/health`, supervisor liveness, persistence DB, Memory Engine reachability, Nango integration, activity-log freshness. One command for any operator to verify the stack |

All three were copy-ports (or shape-ports) of the Tiny-side originals at:
- `tinywins-assistant/lib/marker-blocks.js`
- `tinywins-assistant/lib/skill-frontmatter.js`
- `tinywins-assistant/bin/tiny-doctor.js`

## 3. What Vanguard takes from Hermes (Week 2)

- **Bounded memory budgets + hot/warm routing inside `lib/core/vault.js`.** Each tenant has a "hot" core (≤4K tokens combined SOUL+MEMORY+USER per turn) and a "warm" tier (the rest, retrievable via `lib/core/router.js`). This is the Vanguard equivalent of Tiny's plan to refactor `lib/context-compactor.js`. Touches `lib/core/vault.js` and `lib/core/engine.js`.

- **`vanguard config` runtime switches.** Mirror of `tiny config`. Per-tenant overrides for `dreaming.enabled`, `heartbeat.enabled`, `memory.compaction_threshold_tokens`. Stored at `vault/tenants/{id}/config.json`. Read by `lib/core/engine.js` on every turn. **This is a Vanguard-first feature** — per-tenant config is a multi-tenant requirement.

- **Per-user memory path convention.** Adopt `vault/tenants/{tenant_id}/users/{user_id}/USER.md`. Touches `lib/core/vault.js` and `lib/tenant-resolver.js`.

## 4. What Vanguard takes from Hermes (Week 3+ / architectural)

- **Traces table migration.** Memory Engine schema migration `007_traces.sql` adds `traces(id, tenant_id, task_id, input_payload jsonb, output_payload jsonb, tools_executed jsonb, feedback jsonb, created_at, embedding vector(1536))` with RLS. Vanguard `lib/core/engine.js` writes one row per turn. The Tiny GRPO trainer (`tinywins-assistant/lib/grpo-trainer-pm2.js`) and any future Vanguard self-improvement loop both read from this table. **This is the substrate for the "Self-Evolution Engine" line in [MANIFEST.md](./MANIFEST.md).**

- **Container-isolated subagents.** Vanguard's white-label thesis requires per-tenant isolation. The harness should run each subagent in a sandboxed container (Docker/gVisor/Modal/Daytona — Modal is the proposed default for GCP-centric stacks). Touches `lib/core/harness.js`, `lib/core/loop.js`, `lib/core/specialists.js`. Multi-week.

- **Tool-gating layer.** Each tool ships a `definition.json` (Spectre HARNESS_SPEC §3) that the harness enforces *before* tool execution. Vanguard already gates via `lib/core/tools.js`; the upgrade is moving the policy into per-tool manifests rather than inline guards.

## 5. What Vanguard does NOT take from Hermes

Same do-not-steal list as the Tiny spec, but the Vanguard-specific stakes:

- **Hermes's local-first SQLite memory.** Vanguard's `lib/core/vault.js` uses `better-sqlite3` *for session state* but Memory Engine is the institutional substrate. Hermes-style "`~/.hermes/state.db` is the only memory" is the wrong shape for multi-tenant. Keep the Cloud SQL + pgvector + RLS engine.
- **Hermes's filesystem-only persistence.** Vanguard tenants can't share a filesystem; the Memory Engine is the only acceptable backbone.
- **Wholesale replacement of any future Self-Improvement loop with Hermes's stock reflection.** When Vanguard ships its Self-Evolution Engine, benchmark against Hermes's reflection-pass before adopting either as canonical.

## 6. Roadmap (Vanguard side only)

### Week 1 — landed on `feat/hermes-week-1`
- [x] `docs/hermes-integration.md` — this file
- [x] `lib/core/marker-blocks.js` — managed markdown sections
- [x] `lib/core/skill-frontmatter.js` — agentskills.io scaffolding
- [x] `scripts/vanguard-doctor.js` — health command

### Week 2
- [ ] `lib/core/vault.js` — hot/warm routing for per-tenant memory budgets
- [ ] `lib/core/engine.js` — bootstrap-injection budget enforcement, ≤4K tokens
- [ ] `scripts/vanguard-config.js` — runtime config CLI; backing store `vault/tenants/{id}/config.json`
- [ ] `lib/tenant-resolver.js` — per-user memory path convention (`users/{user_id}/USER.md`)

### Week 3 — architectural
- [ ] Coordinate with Memory Engine team (Tiny side hosts the schema) on `007_traces.sql` migration
- [ ] `lib/core/trace-writer.js` — write one trace row per engine turn
- [ ] Five-pillars vocabulary on top of existing `lib/core/` modules (no rename, just naming the pillars in `MANIFEST.md`)

### Month 2+
- [ ] Container-isolated subagents in `lib/core/harness.js` and `lib/core/specialists.js`
- [ ] Tool-gating manifest format under `lib/core/tools.js`

## 7. Success criteria — Week 1

- `vanguard-doctor` runs in ≤ 5s and surfaces ≥ 6 distinct health signals (slack-bridge, supervisor, persistence, memory-engine, activity-log freshness, nango config, repo cleanliness).
- `lib/core/marker-blocks.js` unit-tested: insert, update, remove, malformed-input, duplicate-name collapse.
- `lib/core/skill-frontmatter.js` correctly parses an agentskills.io-style file and ranks against a free-text prompt.

## 8. Glossary

See the Tiny-side SPEC.md §9. Vanguard-specific terms:
- **Vault** — per-tenant SQLite-backed session store at `vault/tenants/{id}/`. Code in `lib/core/vault.js`. Distinct from Memory Engine (Cloud SQL).
- **Supervisor** — Vanguard's output classifier (`lib/core/supervisor.js`). Hermes pattern.
- **Engine** — Vanguard's main loop (`lib/core/engine.js`).
- **Harness** — Vanguard's worker lifecycle wrapper (`lib/core/harness.js`).

---

*Spec ends. Roadmap lives in §6. When Vanguard items cross Week 3, this doc retires and individual component specs take over (e.g., `docs/vault-hot-warm-routing.md`).*
