# Vanguard Security Architecture: Hard Partitioning Spec

**Status:** DRAFT (Version 0.1)
**Owner:** Vanguard Architecture Team

## Objective
To ensure strict logical isolation and data protection across multiple tenants in a unified Vanguard deployment. Vanguard inherits user permissions via SSO but must maintain "hard" boundaries at the memory, session, and tool layers.

## 1. Identity-Aware Proxying (IAP)
- **SSO Integration:** Vanguard must not store long-lived credentials. It proxies the user's OIDC/SAML token to downstream systems (Google Workspace, GitHub, Slack).
- **Inherited Scoping:** An agent session's "reach" is strictly limited to the intersection of:
    1. The user's corporate permissions.
    2. The agent's configured scope (e.g., "Read-only knowledge base").

## 2. Multi-Tenant Memory Isolation (MTMI)
- **Tenant ID Enforcement:** Every memory entry (hot or cold) must be keyed with a `tenantId`.
- **Namespace Rooting:** 
    - `global`: Shared patterns/learnings (PII-scrubbed).
    - `tenant-{uuid}`: Client-specific knowledge.
    - `user-{id}`: Private user preferences.
- **Cross-Tenant Guardrails:** The `Vault` layer must throw an Access Denied error if a retrieval request lacks a matching `tenantId`.

## 3. Tool Execution Sandboxing
- **Resource Limits:** Tool execution is capped by memory and CPU per-tenant to prevent "noisy neighbor" effects.
- **Network Isolation:** Outbound tool requests are routed through a per-tenant proxy/VPN where applicable to ensure source-IP consistency and audit logging.

## 4. Nightly Dreaming (Skill Evolution) Security
- **Learning Scrubbing:** The "Dreaming Cycle" that creates new skills must run through a **Redactor Specialist** to remove PII and client-specific secrets before the skill logic is promoted to the `global` namespace.
- **Verification Gate:** No autonomously generated skill can be promoted without a successful `checker` audit against the security policy.

## 5. Audit Logging
- Every decision, tool call, and memory retrieval is logged with:
    - `timestamp`
    - `userId`
    - `tenantId`
    - `contextHash`
    - `permissionSource` (the token/ID that authorized the action)

---
*Vanguard: Intelligence with Integrity.*
