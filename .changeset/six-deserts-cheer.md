---
"@duraxis/nestjs": patch
---

Activate declarative transactions automatically for standard Nest class providers using application-scoped property injection. Preserve provider identity and support singleton, transient and request scopes, lifecycle calls after injection, inherited metadata and self-invocation. Deprecate the transactional registration helpers while retaining their named-connection defaults for migration. Self-invocation now honors inner transaction boundaries; constructor-time transactions remain unsupported and are documented explicitly.
