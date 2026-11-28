import type { DynamicModule, FactoryProvider, Provider, ValueProvider } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { DiscoveryModule, DiscoveryService } from "@nestjs/core";
import { discoverEntities, type DuraxisORM, type EntityClass, type Repository } from "@duraxis/orm";
import {
  normalizeDuraxisConnection,
  isDuraxisConfiguration,
  selectDuraxisConnection,
  type DuraxisConfiguration,
  type DuraxisConnectionOptions,
} from "@duraxis/core";
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

function isSharedConfiguration(options: DuraxisModuleOptions | DuraxisConnectionOptions): boolean {
  return (
    isDuraxisConfiguration(options) ||
    "location" in options ||
    "baseDirectory" in options ||
    "migrations" in options ||
    typeof options.autoLoadEntities === "object" ||
    typeof options.entities === "function" ||
    (typeof options.driver === "function" && options.driver.length > 0)
  );
}

async function sharedConnectionOptions(
  config: DuraxisConnectionOptions,
  discovery: DiscoveryService,
  name: string,
): Promise<DuraxisModuleOptions> {
  const normalized = normalizeDuraxisConnection(config);
  const entities = await discoverEntities(config);
  const features = discoverFeatureEntities(discovery, name);

  if (
    config.autoLoadEntities &&
    features.length &&
    (features.length !== entities.length || features.some((entity) => !entities.includes(entity)))
  )
    throw new Error(
      `Duraxis entity discovery differs from forFeature registrations for connection ${name}. Align feature registrations and configured directories.`,
    );

  const driver = config.driver;

  return {
    driver: typeof driver === "function" ? () => driver(normalized.context) : driver,
    database: normalized.database,
    schema: normalized.schema,
    entities,
    closeStorage: config.closeStorage ?? typeof driver === "function",
  };
}

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

function featureModule(entities: readonly EntityClass[], connectionName?: string): DynamicModule {
  const name = normalizeDuraxisConnectionName(connectionName);
  const uniqueEntities = [...new Set(entities)];
  const repositoryProviders = uniqueEntities.map((entity) => repositoryProvider(entity, name));

  @DuraxisFeatureEntities({ connectionName: name, entities: uniqueEntities })
  class DuraxisFeatureEntitiesMarker {}

  return {
    module: DuraxisModule,
    providers: [DuraxisFeatureEntitiesMarker, ...repositoryProviders],
    exports: [...repositoryProviders.map((provider) => provider.provide)],
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
  public static forRoot(options: DuraxisRootModuleOptions | DuraxisConfiguration): DynamicModule {
    if ("connections" in options) {
      selectDuraxisConnection(options);

      return {
        module: DuraxisModule,
        imports: Object.keys(options.connections)
          .sort()
          .map((name) => {
            const selected = selectDuraxisConnection(options, name);
            return DuraxisModule.forRoot({
              ...selected,
              baseDirectory:
                selected.baseDirectory ?? normalizeDuraxisConnection(selected).context.root,
            });
          }),
        exports: [DuraxisModule],
      };
    }

    if (isSharedConfiguration(options)) {
      const config = options as DuraxisConnectionOptions;

      normalizeDuraxisConnection(config);

      const name = normalizeDuraxisConnectionName(config.name);
      const provider: FactoryProvider<DuraxisModuleOptions> = {
        provide: getDuraxisOptionsToken(name),
        inject: [DiscoveryService],
        useFactory: (discovery: DiscoveryService) =>
          sharedConnectionOptions(config, discovery, name),
      };

      return rootModule(name, rootProviders(name, provider));
    }

    const rootOptions = options as DuraxisRootModuleOptions;
    const name = normalizeDuraxisConnectionName(rootOptions.name);

    const connectionOptions: DuraxisModuleOptions = {
      driver: rootOptions.driver,
      ...(rootOptions.entities == null ? {} : { entities: rootOptions.entities }),
      ...(rootOptions.autoLoadEntities == null
        ? {}
        : { autoLoadEntities: rootOptions.autoLoadEntities }),
      ...(rootOptions.database == null ? {} : { database: rootOptions.database }),
      ...(rootOptions.schema == null ? {} : { schema: rootOptions.schema }),
      ...(rootOptions.closeStorage == null ? {} : { closeStorage: rootOptions.closeStorage }),
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
      inject: [DiscoveryService, ...(options.inject ?? [])],
      useFactory: async (discovery: DiscoveryService, ...args: unknown[]) => {
        const config = await options.useFactory(...(args as unknown as TArguments));

        if (isSharedConfiguration(config)) {
          const shared = config as DuraxisConnectionOptions;

          if (shared.name && shared.name !== name)
            throw new Error("Async configuration connection name must match forRootAsync name");

          return sharedConnectionOptions({ ...shared, name }, discovery, name);
        }

        return config as DuraxisModuleOptions;
      },
    };

    return rootModule(name, rootProviders(name, optionsProvider), options.imports);
  }

  public static forFeature(
    entities: readonly EntityClass[],
    connectionName?: string,
  ): DynamicModule {
    return featureModule(entities, connectionName);
  }
}
