# @duraxis/nestjs

Integração oficial entre Duraxis e NestJS. O pacote gerencia conexões, expõe banco/ORM por
injeção, cria repositórios por feature e aplica transações declarativas a providers.

## Instalação

```bash
pnpm add @duraxis/nestjs @duraxis/orm @duraxis/core @duraxis/storage-memory
npm install @duraxis/nestjs @duraxis/orm @duraxis/core @duraxis/storage-memory
yarn add @duraxis/nestjs @duraxis/orm @duraxis/core @duraxis/storage-memory
```

O consumidor também deve ter `@nestjs/common` e `@nestjs/core` 10 ou 11, além dos peers normais
do Nest (`reflect-metadata` e `rxjs`). Importe `reflect-metadata` no bootstrap e habilite decorators
e emissão de metadados no TypeScript.

## `forRoot` e `forFeature`

```ts
import "reflect-metadata";
import { Injectable, Module } from "@nestjs/common";
import { Column, Entity, PrimaryKey, type Repository } from "@duraxis/orm";
import { DuraxisModule, InjectDuraxisRepository, Transactional } from "@duraxis/nestjs";
import { MemoryStorageDriver } from "@duraxis/storage-memory";

@Entity("users")
class User {
  @PrimaryKey()
  id!: string;

  @Column({ type: "string", required: true })
  email!: string;
}

@Injectable()
class UserService {
  constructor(@InjectDuraxisRepository(User) private readonly users: Repository<User>) {}

  @Transactional()
  async create(id: string, email: string): Promise<void> {
    await this.users.insert({ id, email });
  }
}

@Module({
  imports: [
    DuraxisModule.forRoot({
      driver: new MemoryStorageDriver(),
      entities: [User],
      schema: { mode: "create" },
    }),
    DuraxisModule.forTransactionalFeature([User], [UserService]),
  ],
})
export class AppModule {}
```

`forRoot` cria uma conexão global. `forFeature([Entity])` disponibiliza os repositórios somente
no módulo da feature. Conexões nomeadas usam o mesmo nome em `forRoot`, `forFeature` e nos
decorators de injeção.

## `forRootAsync` e `autoLoadEntities`

```ts
DuraxisModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: async (config: ConfigService) => ({
    driver: await createDriver(config),
    autoLoadEntities: true,
    schema: { mode: "create" },
  }),
});
```

Com `autoLoadEntities: true`, entidades declaradas por `forFeature` ou
`forTransactionalFeature` para a mesma conexão são agregadas durante a inicialização. Sem essa
opção, elas também devem constar em `entities` no root.

## Injeção e transações

As APIs públicas incluem `InjectDuraxisRepository`, `InjectDuraxisOrm`,
`InjectDuraxisDatabase`, `InjectDuraxisTransactionManager` e seus geradores de token.

`@Transactional()` é aplicado por proxy: registre o provider com
`forTransactionalFeature(entities, providers)` ou
`forTransactionalProviders(providers)`. Métodos transacionais devem retornar `Promise`. A API
implementa propagação `REQUIRED`, `REQUIRES_NEW`, `SUPPORTS`, `MANDATORY`, `NOT_SUPPORTED` e
`NEVER`; `NESTED`, timeout e níveis além de `DEFAULT`/`SNAPSHOT` são rejeitados. `readOnly`,
`rollbackFor` e `noRollbackFor` também estão disponíveis.

Transações declarativas dependem de metadados e inicialização do Nest; o pacote não é marcado
como livre de efeitos colaterais. Ele não adiciona coordenação distribuída. Requer Node.js
22.12+.
