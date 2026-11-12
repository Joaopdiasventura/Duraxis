# @duraxis/storage-memory

Implementação volátil de `StorageDriver`. É adequada para testes, exemplos e desenvolvimento
local, mas todo o conteúdo desaparece quando a instância é descartada.

## Instalação

```bash
pnpm add @duraxis/storage-memory
npm install @duraxis/storage-memory
yarn add @duraxis/storage-memory
```

`@duraxis/storage` é instalado como dependência.

```ts
import { MemoryStorageDriver } from "@duraxis/storage-memory";

const storage = new MemoryStorageDriver();
await storage.put("example", new TextEncoder().encode("value"), {
  condition: { type: "if-absent" },
});
const object = await storage.get("example");
console.log(object?.version);
```

A API pública é `MemoryStorageDriver`, que implementa leitura, escrita e remoção
condicionais, listagem e métricas. Ela pode ser passada diretamente a `DuraxisDatabase` ou
`DuraxisModule.forRoot`.

Não há persistência entre processos nem coordenação distribuída. Requer Node.js 22.12+ e é
distribuído em ESM, CommonJS e TypeScript.

Release automation verification.
