# Vanguard Manifest: The Enterprise Agent Substrate

## 📦 Package Identity
- **Name:** Project Vanguard
- **Type:** Standalone Multi-Tenant Agent Engine
- **License:** Proprietary (TinyWins)
- **Deployment Target:** Shipyard, Enterprise (On-Prem/Private Cloud)

## 🏗️ Core Architecture
Vanguard is a "headless" substrate that maps AI agency to existing enterprise permissions. It is designed to be "set and forget" once connected to an organization's SSO and Data Lake.

### 1. The Core (lib/core/)
- **Engine:** Multi-tenant session management and prompt orchestration.
- **Router:** Context-aware model selection (OpenAI/Google).
- **Vault:** Secure memory management with tenant-level RLS.
- **Harness:** Autonomous execution loops with maker/checker validation.

### 2. Connectors (MCP)
- **Unified Bridge:** Native support for Slack, Discord, and REST APIs.
- **Dynamic File Systems:** Seamless integration with Google Drive, OneDrive, and local NAS via MCP.
- **Application Stack:** Deep integration with GitHub, Figma, and Jira.

### 3. Intelligence Layers
- **Self-Evolution Engine:** Nightly dreaming cycles to codify recurring tasks into deterministic skills.
- **Skill Optimization:** Karpathy-loop refinement of prompt efficiency and tool usage.
- **Orchestration Tuning:** Autonomous adjustment of sub-agent fan-out based on task complexity.

## 🛠️ Installation & Setup
1. **SSO Linkage:** Configure OIDC/SAML provider in `vanguard.json`.
2. **MCP Registry:** List authorized enterprise application servers.
3. **Tenant Mapping:** Initialize client namespaces in the Memory Engine.
4. **Boot:** `node scripts/vanguard-up.js`

---
*Vanguard: The Future of Enterprise Orchestration.*
