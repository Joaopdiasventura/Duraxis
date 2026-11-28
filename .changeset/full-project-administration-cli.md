---
"@duraxis/cli": minor
---

Expand the migration CLI into project setup and administration tooling with native interactive/non-interactive initialization, standalone Core/ORM and NestJS shared factories, official/custom storage integration, optional migrations, named connections, static diagnostics, configuration commands, generators and compatible dependency updates.

Generate command help and argument validation from one registry. Add native registry/version compatibility checks, package-manager execution, guarded filesystem plans and rollback. Migration cancellation now closes owned database resources cooperatively while preserving in-flight publication semantics and explicitly reporting cleanup failures. No new third-party dependencies or migration checksum compiler changes.

Pre-1.0 behavior change: `init` now creates functional project settings and shared application factories, installs dependencies by default, and requires `--yes` in non-interactive mode. Use `--no-install` for offline scaffolding and explicitly select migrations. Existing executable configurations remain supported and are never automatically rewritten. See the CLI README for trust boundaries and supported combinations.
