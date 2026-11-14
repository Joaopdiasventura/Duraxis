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
    DuraxisModule.forFeature([User]),
  ],
  providers: [UserService],
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

Com `autoLoadEntities: true`, entidades declaradas por `forFeature` para a mesma conexão são
agregadas durante a inicialização. Sem essa
opção, elas também devem constar em `entities` no root.

## Injeção e transações

As APIs públicas incluem `InjectDuraxisRepository`, `InjectDuraxisOrm`,
`InjectDuraxisDatabase`, `InjectDuraxisTransactionManager` e seus geradores de token.

`@Transactional()` funciona automaticamente em classes registradas no array `providers` de
`@Module()`. Use apenas `forFeature([Entity])` para disponibilizar os repositórios; nenhum registro
transacional adicional é necessário. A instância criada pelo Nest mantém sua identidade e injeção
de dependências. Chamadas por controllers, outros serviços e `this.metodo()` passam pelo mesmo
limite transacional, inclusive em providers singleton, transient e request-scoped.

O decorator também pode ser aplicado à classe. Metadados de classe são herdados e as opções do
método prevalecem sobre as da classe. Métodos herdados preservam seus decorators; ao substituir
um método com decorator de método em uma subclasse, reaplique o decorator na nova implementação.
Métodos transacionais devem retornar `Promise`. A API
implementa propagação `REQUIRED`, `REQUIRES_NEW`, `SUPPORTS`, `MANDATORY`, `NOT_SUPPORTED` e
`NEVER`; `NESTED`, timeout e níveis além de `DEFAULT`/`SNAPSHOT` são rejeitados. `readOnly`,
`rollbackFor` e `noRollbackFor` também estão disponíveis.

Para conexões nomeadas, declare `@Transactional({ connectionName: "primary" })` no método ou na
classe e use o mesmo nome na injeção do repositório. Sem essa opção, a conexão é `default`;
`forFeature([Entity], "primary")` não altera a conexão padrão do decorator.

Uma exceção que sai de um limite `REQUIRED` participante marca a transação compartilhada como
rollback-only, salvo exclusão pelas regras de rollback. Capturá-la no chamador não remove essa
marca. Uma exceção capturada inteiramente dentro de um único método não chega ao gerenciador.
`noRollbackFor` permite commit somente para erros correspondentes e nunca anula rollback-only.

### Inicialização e limites

A ligação com o gerenciador usa injeção de propriedade do Nest antes dos hooks de inicialização.
Chamadas a métodos transacionais em `onModuleInit` e `onApplicationBootstrap` são suportadas,
inclusive antes de `app.init()` quando o provider já terminou a injeção. Hooks não são incluídos
implicitamente pelo decorator de classe; podem receber `@Transactional()` explicitamente.

Não execute trabalho transacional em construtores ou inicializadores de campos. Antes da injeção,
métodos já decorados lançam `TransactionalProviderNotReadyError`; novos métodos/overrides de uma
subclasse com apenas metadados de classe herdados e funções de instância só recebem wrappers
ao terminar a construção. Essas chamadas durante a construção podem escapar da interceptação.
Não há promessa de interceptação completa durante a construção, nem garantia de disponibilidade
do gerenciador em factories de inicialização ou construtores de outros providers.

Use providers de classe (`providers: [Service]` ou `useClass`). Instâncias criadas manualmente,
`useValue` e resultados de `useFactory` não recebem injeção de propriedades do Nest; métodos
decorados falham explicitamente quando invocados sem essa ligação. Nessas instâncias, novos
métodos/overrides de subclasses com apenas metadados de classe herdados e funções de instância
permanecem sem wrappers e podem escapar da interceptação. Getters, setters, métodos
estáticos e substituição de métodos após a injeção não são suportados. Ao desligar, o gerenciador
aguarda transações em andamento e rejeita novas transações; depois de remover a conexão, chamadas
decoradas falham com `TransactionManagerNotFoundError`.

### Migração

`forTransactionalFeature(entities, providers, connectionName)` e
`forTransactionalProviders(providers, connectionName)` estão depreciados e continuam disponíveis
para migração. Troque-os por `forFeature(entities, connectionName)` e mova os serviços para
`providers` do módulo consumidor. Para conexões nomeadas, explicite `connectionName` no decorator.
A remoção dos métodos antigos fica para uma versão incompatível futura. Chamadas por `this` agora
aplicam as opções transacionais do método interno, inclusive propagação e regras de rollback.

Veja a [decisão de arquitetura](../../docs/NESTJS_TRANSACTIONS.md) para a análise do ciclo de vida.

Transações declarativas dependem de metadados e inicialização do Nest; o pacote não é marcado
como livre de efeitos colaterais. Ele não adiciona coordenação distribuída. Requer Node.js
22.12+.
