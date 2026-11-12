# Changesets

Every user-visible change to a public package must include a changeset. Run
`pnpm changeset`, select the affected packages and the semantic-version bump,
then commit the generated Markdown file with the implementation.

The packages are versioned independently. `@duraxis/storage-testkit` and the
workspace root are private and must not be selected.

See [`docs/RELEASING.md`](../docs/RELEASING.md) for the complete stable and
prerelease workflows.
