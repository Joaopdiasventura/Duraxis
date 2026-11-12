# @duraxis/storage

Contratos e tipos compartilhados por todos os drivers Duraxis. O pacote não implementa
persistência: ele define `StorageDriver`, operações condicionais, resultados, métricas,
`StorageError` e `assertStorageKey`.

## Instalação

```bash
pnpm add @duraxis/storage
npm install @duraxis/storage
yarn add @duraxis/storage
```

## API principal

- `StorageDriver` e `StorageDriverMetrics`;
- `StorageObject`, `StorageObjectInfo`, `WriteOptions` e `DeleteOptions`;
- `WriteResult`, `DeleteResult`, `StorageError` e `assertStorageKey`.

```ts
import type { StorageDriver } from "@duraxis/storage";

export async function readUtf8(storage: StorageDriver, key: string): Promise<string | null> {
  const object = await storage.get(key);
  return object ? new TextDecoder().decode(object.data) : null;
}
```

Use `@duraxis/storage-memory` ou `@duraxis/storage-disk` para uma implementação pronta. Um
driver customizado deve respeitar a semântica de versões, condições e listagem do contrato;
o testkit de conformidade ainda é interno e não é publicado.

Requer Node.js 22.12+. O pacote inclui ESM, CommonJS e declarações TypeScript.
