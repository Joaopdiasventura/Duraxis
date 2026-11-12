# @duraxis/storage-disk

Driver assíncrono de filesystem para Duraxis. Ele armazena objetos e journal em um diretório
local e exige posse exclusiva desse diretório enquanto estiver aberto.

## Instalação

```bash
pnpm add @duraxis/storage-disk
npm install @duraxis/storage-disk
yarn add @duraxis/storage-disk
```

```ts
import { AsyncDiskStorageDriver } from "@duraxis/storage-disk";

const storage = await AsyncDiskStorageDriver.open({ directory: "./data/duraxis" });
try {
  await storage.put("example", new TextEncoder().encode("value"), {
    condition: { type: "if-absent" },
  });
} finally {
  await storage.close();
}
```

A API exporta `AsyncDiskStorageDriver` e os tipos de opção, capacidades de durabilidade,
injeção de falhas e recuperação de posse. A recuperação de uma trava abandonada exige a
confirmação explícita definida pela API e só deve ocorrer após verificar acesso exclusivo.

O driver integra-se a `@duraxis/core` por meio do contrato de `@duraxis/storage`. Ele não oferece
coordenação entre hosts e as garantias frente a perda de energia dependem do suporte do sistema
operacional a sincronização de arquivos e diretórios. Requer Node.js 22.12+.
