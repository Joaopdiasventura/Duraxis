import type { DynamicModule, FactoryProvider, Provider, ValueProvider } from "@nestjs/common";
import { Module } from "@nestjs/common";
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
  normalizeDuraxisConnectionName,
} from "./duraxis.tokens.js";
import { DuraxisConnectionRegistry, DuraxisConnectionRegistryModule } from "./duraxis.registry.js";

function rootProviders(
  name: string,
  optionsProvider: Provider<DuraxisModuleOptions>,
): readonly Provider[] {
  const connectionToken = getDuraxisConnectionToken(name);
  const ormToken = getDuraxisOrmToken(name);
  const databaseToken = getDuraxisDatabaseToken(name);
  return [
    optionsProvider,
    {
      provide: connectionToken,
      inject: [getDuraxisOptionsToken(name), DuraxisConnectionRegistry],
      useFactory: async (
        options: DuraxisModuleOptions,
        registry: DuraxisConnectionRegistry,
      ): Promise<DuraxisNestConnection> => await registry.create(name, options),
    },
    {
      provide: ormToken,
      inject: [connectionToken],
      useFactory: (connection: DuraxisNestConnection) => connection.orm,
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
    imports: [DuraxisConnectionRegistryModule, ...(imports ?? [])],
    providers: [...providers],
    exports: [getDuraxisOrmToken(name), getDuraxisDatabaseToken(name)],
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
      entities: options.entities,
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
    const name = normalizeDuraxisConnectionName(connectionName);
    const uniqueEntities = [...new Set(entities)];
    const providers = uniqueEntities.map((entity) => repositoryProvider(entity, name));
    return {
      module: DuraxisModule,
      providers,
      exports: providers.map((provider) => provider.provide),
    };
  }
}
