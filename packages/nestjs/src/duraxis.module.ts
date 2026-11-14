import type { DynamicModule, FactoryProvider, Provider, Type, ValueProvider } from "@nestjs/common";
import { Module, Scope } from "@nestjs/common";
import { DiscoveryModule, DiscoveryService } from "@nestjs/core";
import type { DuraxisORM, EntityClass, Repository } from "@duraxis/orm";
import { DuraxisNestConnection } from "./duraxis.connection.js";
import type {
  DuraxisModuleAsyncOptions,
  DuraxisModuleOptions,
  DuraxisRootModuleOptions,
} from "./duraxis.interfaces.js";
import {
  getDuraxisConnectionToken,
  getDuraxisDatabaseToken,
  getDuraxisOptionsToken,
  getDuraxisOrmToken,
  getDuraxisRepositoryToken,
  getDuraxisTransactionManagerToken,
  normalizeDuraxisConnectionName,
} from "./duraxis.tokens.js";
import { DuraxisConnectionRegistry, DuraxisConnectionRegistryModule } from "./duraxis.registry.js";
import { discoverFeatureEntities, DuraxisFeatureEntities } from "./duraxis.feature-discovery.js";
import { TransactionContextManager } from "./transactions/transaction-context.manager.js";
import { TransactionManagerRegistry } from "./transactions/transaction-manager.registry.js";
import { TransactionManager } from "./transactions/transaction.manager.js";
import { setTransactionalDefaultConnection } from "./transactions/transactional.instrumentation.js";

function rootProviders(
  name: string,
  optionsProvider: Provider<DuraxisModuleOptions>,
): readonly Provider[] {
  const connectionToken = getDuraxisConnectionToken(name);
  const ormToken = getDuraxisOrmToken(name);
  const databaseToken = getDuraxisDatabaseToken(name);
  const transactionManagerToken = getDuraxisTransactionManagerToken(name);
  return [
    optionsProvider,
    {
      provide: connectionToken,
      inject: [getDuraxisOptionsToken(name), DuraxisConnectionRegistry, DiscoveryService],
      useFactory: async (
        options: DuraxisModuleOptions,
        registry: DuraxisConnectionRegistry,
        discovery: DiscoveryService,
      ): Promise<DuraxisNestConnection> => {
        const entities = new Set(options.entities ?? []);
        if (options.autoLoadEntities)
          for (const entity of discoverFeatureEntities(discovery, name)) entities.add(entity);
        return await registry.create(name, { ...options, entities: [...entities] });
      },
    },
    {
      provide: transactionManagerToken,
      inject: [connectionToken, TransactionContextManager, TransactionManagerRegistry],
      useFactory: (
        connection: DuraxisNestConnection,
        contexts: TransactionContextManager,
        managers: TransactionManagerRegistry,
      ): TransactionManager => {
        const manager = new TransactionManager(name, connection, connection.orm, contexts);
        managers.register(name, manager);
        connection.setBeforeClose(async () => {
          await manager.shutdown();
          managers.unregister(name, manager);
        });
        return manager;
      },
    },
    {
      provide: ormToken,
      inject: [transactionManagerToken],
      useFactory: (transactions: TransactionManager) => transactions.ormProxy,
    },
    {
      provide: databaseToken,
      inject: [connectionToken],
      useFactory: (connection: DuraxisNestConnection) => connection.database,
    },
  ];
}

function rootModule(
  name: string,
  providers: readonly Provider[],
  imports: DynamicModule["imports"] = [],
): DynamicModule {
  return {
    module: DuraxisModule,
    global: true,
    imports: [DiscoveryModule, DuraxisConnectionRegistryModule, ...(imports ?? [])],
    providers: [...providers],
    exports: [
      getDuraxisOrmToken(name),
      getDuraxisDatabaseToken(name),
      getDuraxisTransactionManagerToken(name),
    ],
  };
}

function featureModule(
  entities: readonly EntityClass[],
  services: readonly Type<object>[],
  connectionName?: string,
): DynamicModule {
  const name = normalizeDuraxisConnectionName(connectionName);
  const uniqueEntities = [...new Set(entities)];
  const uniqueServices = [...new Set(services)];
  const repositoryProviders = uniqueEntities.map((entity) => repositoryProvider(entity, name));
  // Compatibility registrations still let Nest construct and inject the service once.
  const serviceProviders = uniqueServices.flatMap((service): Provider[] => {
    return [
      { provide: service, useClass: service, scope: Scope.DEFAULT },
      {
        provide: Symbol(`${service.name} default transaction connection`),
        inject: [service],
        useFactory: (instance: object): string => {
          setTransactionalDefaultConnection(instance, name);
          return name;
        },
      },
    ];
  });

  @DuraxisFeatureEntities({ connectionName: name, entities: uniqueEntities })
  class DuraxisFeatureEntitiesMarker {}

  return {
    module: DuraxisModule,
    providers: [DuraxisFeatureEntitiesMarker, ...repositoryProviders, ...serviceProviders],
    exports: [...repositoryProviders.map((provider) => provider.provide), ...uniqueServices],
  };
}

function repositoryProvider<TEntity extends object>(
  entity: EntityClass<TEntity>,
  connectionName: string,
): FactoryProvider<Repository<TEntity>> {
  return {
    provide: getDuraxisRepositoryToken(entity, connectionName),
    inject: [getDuraxisOrmToken(connectionName)],
    useFactory: (orm: DuraxisORM): Repository<TEntity> => orm.getRepository(entity),
  };
}

@Module({})
export class DuraxisModule {
  public static forRoot(options: DuraxisRootModuleOptions): DynamicModule {
    const name = normalizeDuraxisConnectionName(options.name);
    const connectionOptions: DuraxisModuleOptions = {
      driver: options.driver,
      ...(options.entities == null ? {} : { entities: options.entities }),
      ...(options.autoLoadEntities == null ? {} : { autoLoadEntities: options.autoLoadEntities }),
      ...(options.database == null ? {} : { database: options.database }),
      ...(options.schema == null ? {} : { schema: options.schema }),
      ...(options.closeStorage == null ? {} : { closeStorage: options.closeStorage }),
    };
    const optionsProvider: ValueProvider<DuraxisModuleOptions> = {
      provide: getDuraxisOptionsToken(name),
      useValue: connectionOptions,
    };
    return rootModule(name, rootProviders(name, optionsProvider));
  }

  public static forRootAsync<TArguments extends readonly unknown[]>(
    options: DuraxisModuleAsyncOptions<TArguments>,
  ): DynamicModule {
    const name = normalizeDuraxisConnectionName(options.name);
    const optionsProvider: FactoryProvider<DuraxisModuleOptions> = {
      provide: getDuraxisOptionsToken(name),
      inject: options.inject == null ? [] : [...options.inject],
      useFactory: options.useFactory,
    };
    return rootModule(name, rootProviders(name, optionsProvider), options.imports);
  }

  public static forFeature(
    entities: readonly EntityClass[],
    connectionName?: string,
  ): DynamicModule {
    return featureModule(entities, [], connectionName);
  }

  /** @deprecated Use forFeature(entities, connectionName) and regular module providers. */
  public static forTransactionalFeature(
    entities: readonly EntityClass[],
    providers: readonly Type<object>[],
    connectionName?: string,
  ): DynamicModule {
    return featureModule(entities, providers, connectionName);
  }

  /** @deprecated Declare services in the consuming module's providers array. */
  public static forTransactionalProviders(
    providers: readonly Type<object>[],
    connectionName?: string,
  ): DynamicModule {
    return featureModule([], providers, connectionName);
  }
}
