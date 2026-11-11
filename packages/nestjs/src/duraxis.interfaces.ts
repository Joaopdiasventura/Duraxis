import type { InjectionToken, ModuleMetadata } from "@nestjs/common";
import type { DuraxisDatabaseOptions } from "@duraxis/core";
import type { DuraxisOrmOptions, EntityClass } from "@duraxis/orm";
import type { StorageDriver } from "@duraxis/storage";

export type DuraxisDriverFactory = () => StorageDriver | Promise<StorageDriver>;

export interface DuraxisModuleOptions {
  readonly driver: StorageDriver | DuraxisDriverFactory;
  readonly entities: readonly EntityClass[];
  readonly database?: Omit<DuraxisDatabaseOptions, "storage">;
  readonly schema?: DuraxisOrmOptions["schema"];
  /**
   * Defaults to true for a driver factory and false for a supplied driver instance.
   */
  readonly closeStorage?: boolean;
}

export interface DuraxisRootModuleOptions extends DuraxisModuleOptions {
  readonly name?: string;
}

type InjectTokens<TArguments extends readonly unknown[]> = {
  readonly [TIndex in keyof TArguments]: InjectionToken;
};

export interface DuraxisModuleAsyncOptions<
  TArguments extends readonly unknown[] = readonly unknown[],
> extends Pick<ModuleMetadata, "imports"> {
  readonly name?: string;
  readonly inject?: InjectTokens<TArguments>;
  readonly useFactory: (
    ...arguments_: TArguments
  ) => DuraxisModuleOptions | Promise<DuraxisModuleOptions>;
}
