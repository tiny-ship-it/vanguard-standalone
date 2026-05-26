# Project: Vanguard (Standalone White-Label Agent)
**Status:** ACTIVE (Consolidated)
**Last Updated:** 2026-05-10T20:45:00.000Z
**Objective:** Develop Vanguard as a self-contained, high-reliability, white-label agent package for Shipyard and clients.

## Phase 1: Core Consolidation (COMPLETED)
- [x] Harvest useful code from Assistant Core, Metropolis, First Tiny, and Portal. ✅ (2026-05-10)
- [x] White-labeling: Removed "Shippy" and portal-specific hardcoding. ✅ (2026-05-10)
- [x] Archived legacy projects to `/opt/openclaw/archive/`. ✅ (2026-05-10)
- [x] Initialized clean repo structure at `/opt/openclaw/vanguard-standalone/`. ✅ (2026-05-10)

## Phase 2: Standalone Package Development
- [x] Implement 'SSO & Permission Proxying' workstream. ✅ (2026-05-11)
  - Refactored tenant resolution to prioritize SSO/Corporate identity over Slack ID.
  - Implemented `corporate-{email}` tenant naming convention.
- [x] Port and re-base on Hermes Supervisor Pattern. ✅ (2026-05-26)
  - Ported `lib/flux-supervisor.js` to `lib/core/supervisor.js`.
  - Implemented [ACK]/[ESCALATE]/[RETRY]/[SKIP] classification logic.
  - Verified with `harness/test-supervisor.js`.
- [x] Audit `vanguard-standalone/lib/` for remaining external dependencies. ✅ (2026-05-20)
  - Verified clean separation; only standard node modules and better-sqlite3 used.
- [x] Implement high-reliability Slack bridge with health checks. ✅ (2026-05-20)
  - Added health check endpoint (`/health`) on port 3002.
  - Improved error handling and logging in `scripts/slack-bridge.js`.
  - Fixed dependency resolution for `llm-client` and `memory-client`.
- [ ] Implement secure Discord/API bridge.
- [ ] Define deployment script for rapid client onboarding.
- [ ] Update Memory Engine mapping for Vanguard-exclusive operation.

## Key Decisions
- **Project Vanguard is the sole flagship.** First Tiny and Metropolis are merged/shelved.
- **Headless First:** The agent must operate flawlessly without the Glass Portal.
- **White-Label Native:** Code is generic; deployment-specific identities (like "Shippy") are configured via external environment/config only.

## Session Log
- 2026-05-26T16:35:00.000Z | maker | Re-based Vanguard on Hermes Supervisor Pattern. Ported classification logic and quality rules to `lib/core/supervisor.js`. Verified autonomous intent markers with test suite.
- 2026-05-11T15:55:00.000Z | maker | Implemented SSO-based tenant resolution in `lib/tenant-resolver.js`. Refactored resolution hierarchy to prioritize corporate identity for cross-platform continuity. Verified with `test-sso-resolution.js`. Branch: `feat/vanguard-sso`.
- 2026-05-10T20:45:00.000Z | maker | Completed "Harvest and Archive" sweep. Consolidated Assistant Core, Metropolis, and First Tiny into the new `/opt/openclaw/vanguard-standalone/` engine. Verified white-labeling and removed portal dependencies.
