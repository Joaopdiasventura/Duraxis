# @duraxis/orm

Typed, framework-independent object mapping for `@duraxis/core`. The ORM delegates storage,
snapshots, CAS commits, index maintenance, query planning and execution to the Duraxis engine.

## Decorators

The package uses the repository's legacy TypeScript decorator mode
(`experimentalDecorators: true`). It does not require `reflect-metadata` and does not read emitted
design types.

```ts
Entity(name?: string): ClassDecorator
Column(options: ColumnOptions): PropertyDecorator
PrimaryKey(): PropertyDecorator
Index(options?: PropertyIndexOptions): PropertyDecorator
Index(name: string, fields: readonly CompositeIndexField[], options?: CompositeIndexOptions): ClassDecorator
```

Names must match `[a-zA-Z][a-zA-Z0-9_-]{0,63}`. Every registered entity has exactly one string
primary key. The primary key is the Duraxis logical record ID and is not duplicated in the stored
document. Decorated properties from base classes are inherited; entity names are not. Redeclaring
an inherited column, primary key or index is rejected. Registries copy and finalize decorator
metadata, so entities and independent ORM instances cannot mutate each other's finalized metadata.

## Usage

```ts
import { DuraxisDatabase } from "@duraxis/core";
import { MemoryStorageDriver } from "@duraxis/storage-memory";
import { Column, DuraxisORM, Entity, Index, PrimaryKey } from "@duraxis/orm";

@Entity("users")
class User {
  @PrimaryKey()
  id!: string;

  @Column({ type: "string", required: true })
  name!: string;

  @Index({ unique: true })
  @Column({ type: "string", required: true })
  email!: string;

  @Column({ type: "number", nullable: true })
  age!: number | null;
}

const storage = new MemoryStorageDriver();
const database = new DuraxisDatabase({ storage });
const orm = new DuraxisORM({
  database,
  entities: [User],
  schema: { mode: "create" },
});

await orm.initialize();
const users = orm.getRepository(User);

await users.insert({
  id: "123",
  name: "João",
  email: "joao@example.com",
  age: 25,
});

const adults = await users.find({
  where: { age: { gte: 18 } },
  orderBy: { age: "ASC" },
});

await orm.transaction(async (manager) => {
  const transactionalUsers = manager.getRepository(User);
  await transactionalUsers.update("123", { age: 26 });
  const updated = await transactionalUsers.findById("123"); // read-your-writes
  console.log(updated);
});

await orm.close();
await database.close({ closeStorage: true });
```

`create` only constructs an entity. `insert` fails if the ID exists. `update` fails if it does not
exist and ignores `undefined` changes while preserving explicit `null`. `save` and `upsert` both
replace the complete mapped document using upsert semantics. `delete` returns whether a record was
present.

Hydration uses `Object.create(Entity.prototype)` and own data properties. Constructors, setters and
business logic are not run implicitly. Methods on the prototype remain available. Only decorated
columns are serialized; missing fields and `null` remain distinct.

Schema `validate` is read-only. Schema `create` creates missing collections and indexes, but never
removes or rewrites fields, data or indexes. Incompatible definitions fail with
`SchemaViolationError`.

The ORM does not own a supplied database by default. Set `closeDatabase: true` to close it with the
ORM, and `closeStorage: true` to close its storage too. Transaction callbacks are never retried.
`TransactionConflictError` and `CommitOutcomeUnknownError` remain distinguishable.

Relationships, migrations, generated IDs, nested transactions/savepoints, lazy loading and a
NestJS module are intentionally outside this first version.
