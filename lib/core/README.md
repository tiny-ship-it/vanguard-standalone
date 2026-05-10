# Vanguard AI Agent Platform

Vanguard is the evolved multi-tenant engine for TinyWins agents. It provides standardized model routing, memory isolation, and tenant-aware orchestration.

## Core Pillars

### 1. Unified Routing (Router)
- **Tiered Selection:** LEAF, STANDARD, SYNTHESIS, DEEP_REASONING.
- **Provider Load-Balancing:** Automatic round-robin across OpenAI, Google Vertex, and Anthropic.
- **Auto-Routing:** Task classification via LEAF models to select the appropriate tier.
- **Tenant Constraints:** Budget-aware routing (downgrading tiers based on usage).

### 2. Multi-Tenant Memory (Vault)
- **Isolation Scopes:**
  - `personal`: Strictly for the individual user (Slack DM context).
  - `channel`: Shared across users in a specific channel/thread.
  - `workspace`: Global organization-wide knowledge.
- **Deduplication:** LLM-powered fact extraction and cosine similarity check to prevent redundancy.
- **Shielding:** Automated security evaluation of inbound external content.

### 3. Execution Harness (Harness)
- **Standardized State:** Per-agent and per-project `STATE.md` tracking.
- **Context Injection:** Automatic retrieval of relevant tenant context before task execution.
- **Verification:** Built-in quality gates (Pattern 5: Checker agents).

## Directory Structure
- `lib/vanguard/router.js`: Model selection and routing logic.
- `lib/vanguard/vault.js`: Memory management and isolation.
- `lib/vanguard/harness.js`: Agent lifecycle and state orchestration.
