# @duraxis/nestjs changelog

## 0.1.2

### Patch Changes

- a447bb5: Activate declarative transactions automatically for standard Nest class providers using application-scoped property injection. Preserve provider identity and support singleton, transient and request scopes, lifecycle calls after injection, inherited metadata and self-invocation. Deprecate the transactional registration helpers while retaining their named-connection defaults for migration. Self-invocation now honors inner transaction boundaries; constructor-time transactions remain unsupported and are documented explicitly.

## 0.1.1

### Patch Changes

- 0b272bd: Improve disk storage ownership recovery and NestJS lifecycle management to safely handle abandoned locks and application restarts
- @duraxis/orm@0.1.0

This file is maintained by Changesets. Future releases will add versioned
entries automatically.
