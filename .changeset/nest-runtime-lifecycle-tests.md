---
"@duraxis/nestjs": patch
"@duraxis/storage-s3": patch
---

Align S3 integration test dependencies with the Nest 12 runtime used by the NestJS package, preventing duplicate framework injection tokens. Verify that Duraxis connection cleanup and hooks reject shutdown failures, while Nest 12 reports those hook errors through its logger and completes application shutdown. Document the framework shutdown behavior and shared-runtime requirement.
