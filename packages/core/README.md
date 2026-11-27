# @duraxis/core

Motor embutido do Duraxis. Ele usa um `StorageDriver` para manter catálogo, documentos, índices,
manifests e histórico de commits, e expõe transações, snapshots, consultas e manutenção.

## Instalação

Escolha também um driver:

```bash
pnpm add @duraxis/core @duraxis/storage-memory
npm install @duraxis/core @duraxis/storage-memory
yarn add @duraxis/core @duraxis/storage-memory
```

## Uso

```ts
import { DuraxisDatabase } from "@duraxis/core";
import { MemoryStorageDriver } from "@duraxis/storage-memory";

const database = new DuraxisDatabase({ storage: new MemoryStorageDriver() });

await database.defineCollection({
  name: "notes",
  fields: { title: { type: "string", required: true } },
  allowAdditionalFields: true,
  indexes: [],
});

await database.transaction((transaction) => {
  transaction.putDocument("notes", "1", { title: "Duraxis" });
});

const note = await database.getDocument("notes", "1");
await database.close();
```

## API principal

- `DuraxisDatabase`, `Transaction` e leitura por snapshot;
- definições de coleção, campos e índices;
- modelo, validação, planejamento e execução de consultas;
- B+ tree, índices primário/secundário e verificadores;
- recuperação, integridade, checkpoint de histórico e garbage collection;
- erros de conflito, estado de transação e resultado de commit desconhecido.

O pacote depende somente de `@duraxis/storage` em runtime. Drivers são instalados
separadamente. `@duraxis/orm` adiciona entidades e repositórios sobre esta API.

Duraxis ainda está em `0.x`. As garantias efetivas dependem do driver; não há coordenação
distribuída, e o formato persistido pode evoluir. Requer Node.js 24.15.0+.

## Transactional schema evolution

Transactions expose `getCollectionDefinitions()`, `alterCollection(name,
definition)`, `dropCollection(name)`, and streaming `scanCollection(name)`.
Catalog changes are visible to subsequent transaction operations. Replacement
validates existing and pending documents against the final schema, including
foreign keys; indexes rebuild when indexed field definitions change. Collection
drops remove logical records and index roots while captured snapshots retain
visibility. Physical deletion remains the garbage collector's responsibility.
A dropped collection cannot be recreated in the same transaction.

Trusted subsystems can use `getMetadata(namespace)` and `putMetadata(namespace,
bytes)` for protected transactional metadata. Ordinary raw-key writes still
reject reserved namespaces. This is an explicit internal extension mechanism,
not access control against code with direct storage access. Metadata uses existing
primary-tree entries and format-1 manifests. Older Core versions cannot perform
all full-tree operations on databases containing these new reserved entries;
upgrade Core before adopting migrations and do not downgrade migrated databases.

Affected-schema validation stages final records in memory. Streaming reads do not
bound transaction memory, and schema-mutated index queries may scan and sort.
For versioned evolution use [`@duraxis/migrations`](../migrations/README.md).
