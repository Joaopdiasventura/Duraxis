# @duraxis/orm

Camada de mapeamento de entidades sobre `@duraxis/core`. Fornece decorators de metadados,
validação/criação de schema, repositórios tipados, query builder e transações ORM.

## Instalação

```bash
pnpm add @duraxis/orm @duraxis/core @duraxis/storage-memory
npm install @duraxis/orm @duraxis/core @duraxis/storage-memory
yarn add @duraxis/orm @duraxis/core @duraxis/storage-memory
```

Habilite `experimentalDecorators` e `emitDecoratorMetadata` no TypeScript.

## Uso

```ts
import { DuraxisDatabase } from "@duraxis/core";
import { Column, DuraxisORM, Entity, PrimaryKey } from "@duraxis/orm";
import { MemoryStorageDriver } from "@duraxis/storage-memory";

@Entity("users")
class User {
  @PrimaryKey()
  id!: string;

  @Column({ type: "string", required: true })
  email!: string;
}

const database = new DuraxisDatabase({ storage: new MemoryStorageDriver() });
const orm = new DuraxisORM({
  database,
  entities: [User],
  schema: { mode: "create" },
  closeDatabase: true,
});

await orm.initialize();
const users = orm.getRepository(User);
await users.insert({ id: "1", email: "user@example.com" });
const user = await users.findById("1");
await orm.close();
```

## API principal

- `@Entity`, `@Column`, `@PrimaryKey` e `@Index`;
- `DuraxisORM`, `Repository` e `QueryBuilder`;
- `find`, `findOne`, `findById`, paginação, contagem, inserção, update, upsert e delete;
- `orm.transaction`, `OrmTransactionManager` e contexto transacional;
- registro/metadados, mapeadores, schema manager e erros específicos.

O ORM exige inicialização antes de obter repositórios. O modo `create` cria estruturas
ausentes, mas não é uma ferramenta geral de migrações destrutivas; `validate` verifica o schema
existente. Decorators registram metadados quando a classe é avaliada, por isso este pacote não é
marcado como livre de efeitos colaterais. Requer Node.js 22.12+.
