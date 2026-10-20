# Docker runtime validation

Workspace: `/home/ubuntu/Project/nail/.worktrees/docker-runtime`, branch `feature/docker-runtime`.
Base commit: `3af3c89`. Results below were collected before integration; the owner subsequently authorized committing and merging this work locally to `main`. No push or deployment is authorized by that integration request.

## Executed checks

- `docker build --target app -t nail-docker-runtime:local .`: passed. Frozen Bun 1.4.3 dependencies, default Next.js 16.4.2 Turbopack compilation, TypeScript and static generation passed inside the Docker build.
- `docker build --target connector -t nail-connector-runtime:local .`: passed. Bun compiled daemon ran in the Node 24 Debian runtime image.
- `node scripts/docker-runtime-smoke.mjs`: passed on the local rootless Docker daemon with disposable state. Verifies required secrets, login and origin guard, actual HTTP-to-socket discovery and check, truthful missing-client status, non-root/capability-free app process, no account/Docker socket mounts in the app, and SQLite provider state after restart.
- `../../node_modules/.bin/vitest run`: 35 files, 142 tests passed.
- `node /home/ubuntu/Project/nail/node_modules/eslint/bin/eslint.js .`: passed.
- `git diff --check`: passed.

## Reproduced failures and resolutions

- Initial app image compilation failed because subscription routes still supplied removed `loadConfig` dependencies. Removed direct binding-file imports and obsolete arguments; Docker compilation subsequently passed. Subscription creation now returns a safe 503 for unavailable connector configuration.
- First real connector startup failed because the strict absent-binary path check requires an existing parent directory. Added the empty `/opt/vendor-bin` directory; the test now receives real `not_installed` diagnostics rather than inventing account success.
- Restricted app bootstrap initially could not chmod after ownership transfer. The smoke invocation explicitly grants only the required initialization capabilities, then verifies PID 1 retains zero effective capabilities.
- Production auth correctly rejected an HTTP application origin. The test supplies an HTTPS origin while explicitly treating direct loopback HTTP and cookie forwarding as backend-only verification, not TLS/browser verification.
- A restart changed the ephemeral published port. The test re-discovers the port after restart rather than assuming its previous address remains valid.

## Final review

Self-review (no subagent tool available), using the code-reviewer checklist. Reviewed the changed descriptor protocol, exact-field/identifier/duplicate validation, configuration/socket ownership boundaries, HTTP wiring, image mounts, entrypoint privilege transition and integration-test cleanup.

No unresolved critical or important issue found within this packaging scope. This is author self-review, not independent review; obtain independent review before merge.

Ruling: retain explicit build targets and Linux x64 connector compilation for the existing Dockerfile rather than expanding this continuation into multi-platform release tooling. Cost if wrong: other architectures need a supported target selection before deployment.

Deferred minor: the Dockerfile's final/default target is the connector. The runtime guide requires explicit `--target app` or `--target connector`; changing the default can be considered independently.

## Not certified

No real owner credentials, vendor login or live inference was used. No TLS proxy/browser session, VPS deployment, host bind-mount UID mapping, sandbox/worker integration, resource-limit acceptance, image vulnerability scan or cross-architecture build was verified. Existing subscription inference gates remain closed. Temporary test containers and volumes were removed; locally built image tags remain available.
