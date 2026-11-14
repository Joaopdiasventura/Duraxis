# Duraxis

Duraxis é um banco de dados embutido e modular escrito em TypeScript. O projeto separa o
contrato de armazenamento, os drivers, o motor transacional, o mapeamento objeto-documento e a
integração com NestJS para que cada aplicação instale apenas as camadas de que precisa.

O projeto está em desenvolvimento inicial (`0.x`). As APIs e o formato persistido podem mudar
entre versões menores; avalie os testes e os limites documentados antes de usar dados importantes.

## Arquitetura modular

| Pacote                     | Responsabilidade                                                                  |
| -------------------------- | --------------------------------------------------------------------------------- |
| `@duraxis/storage`         | Contrato `StorageDriver`, tipos de leitura/escrita condicional e erros comuns.    |
| `@duraxis/storage-memory`  | Driver volátil em memória para testes e desenvolvimento.                          |
| `@duraxis/storage-disk`    | Driver assíncrono para um diretório local, com journal e posse exclusiva.         |
| `@duraxis/storage-s3`      | Driver Amazon S3 com escritas condicionais e cliente AWS gerenciado internamente. |
| `@duraxis/core`            | Banco transacional, catálogo, índices, consultas, recuperação e coleta de lixo.   |
| `@duraxis/orm`             | Entidades com decorators, schema, repositórios, queries e transações ORM.         |
| `@duraxis/nestjs`          | Módulos dinâmicos, injeção e transações declarativas para NestJS.                 |
| `@duraxis/storage-testkit` | Suíte interna de conformidade para drivers; pacote privado, não publicado.        |

As dependências de execução seguem a direção `storage → drivers/core → orm → nestjs`.

## Requisitos

- Node.js 22.12 ou mais recente;
- pnpm 12.16.1 ou mais recente para desenvolver no monorepo;
- TypeScript com `experimentalDecorators` e `emitDecoratorMetadata` ao usar ORM/NestJS;
- NestJS 10 ou 11 para `@duraxis/nestjs`.

## Instalação

Para um banco em memória:

```bash
pnpm add @duraxis/core @duraxis/storage-memory
# npm install @duraxis/core @duraxis/storage-memory
# yarn add @duraxis/core @duraxis/storage-memory
```

Para persistência local, troque o driver por `@duraxis/storage-disk`. Para persistência no S3,
use [`@duraxis/storage-s3`](packages/storage-s3/README.md), sem instalar o SDK AWS separadamente. Para mapeamento de
entidades, adicione `@duraxis/orm`; projetos NestJS também adicionam `@duraxis/nestjs` e os peers
do Nest.

## Uso básico

```ts
import { DuraxisDatabase } from "@duraxis/core";
import { MemoryStorageDriver } from "@duraxis/storage-memory";

const database = new DuraxisDatabase({ storage: new MemoryStorageDriver() });

await database.defineCollection({
  name: "users",
  fields: { email: { type: "string", required: true } },
  allowAdditionalFields: false,
  indexes: [{ name: "email", unique: true, field: "email" }],
});

await database.transaction((transaction) => {
  transaction.putDocument("users", "user-1", { email: "user@example.com" });
});

const user = await database.getDocument("users", "user-1");
await database.close();
```

O README de cada pacote descreve as APIs e limitações específicas.

## Desenvolvimento local

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm typecheck
pnpm build
pnpm test
```

`pnpm pack:check` gera tarballs em um diretório temporário, valida manifests e exports e instala
os seis pacotes em um projeto externo para executar smoke tests ESM, CommonJS e TypeScript.
Nenhum desses comandos publica no npm.

## Versionamento e publicação

O monorepo usa Changesets com versões independentes. Toda alteração publicável deve incluir um
arquivo criado por `pnpm changeset`. Depois que a CI aprova e o PR é mesclado, o workflow de
release cria ou atualiza um Release PR. Mesclar esse PR publica apenas versões ainda ausentes no
npm e cria changelogs e tags por pacote.

```bash
pnpm changeset
pnpm changeset:status
pnpm version-packages # normalmente executado pelo Release PR
pnpm validate:release
pnpm release          # publica: não execute como validação local
```

O fluxo estável, prereleases `alpha`/`beta`/`rc`, releases de um pacote, bootstrap inicial e
Trusted Publishing estão em [`docs/RELEASING.md`](docs/RELEASING.md).

## Licença

Distribuído sob a licença [ISC](LICENSE).
