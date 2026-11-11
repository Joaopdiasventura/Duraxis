import type { FactoryProvider, Type } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { normalizeDuraxisConnectionName } from "../duraxis.tokens.js";
import { TransactionManagerRegistry } from "./transaction-manager.registry.js";
import { transactionalOptions } from "./transactional.decorator.js";

const LIFECYCLE_METHODS = new Set<PropertyKey>([
  "onModuleInit",
  "onApplicationBootstrap",
  "onModuleDestroy",
  "beforeApplicationShutdown",
  "onApplicationShutdown",
]);

export function createTransactionalServiceProxy<TService extends object>(
  instance: TService,
  managers: TransactionManagerRegistry,
  defaultConnectionName: string,
): TService {
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(instance, {
    get(target, property) {
      const cached = methods.get(property);
      if (cached) return cached;
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value != "function") return value;
      const options = LIFECYCLE_METHODS.has(property)
        ? undefined
        : transactionalOptions(target, value);
      const method = options
        ? (...arguments_: readonly unknown[]) => {
            const connectionName = normalizeDuraxisConnectionName(
              options.connectionName ?? defaultConnectionName,
            );
            return managers
              .get(connectionName)
              .execute(options, `${target.constructor.name}.${String(property)}`, () =>
                Reflect.apply(value, target, arguments_),
              );
          }
        : value.bind(target);
      methods.set(property, method);
      return method;
    },
  });
}

export function transactionalServiceProvider<TService extends object>(
  service: Type<TService>,
  defaultConnectionName: string,
): FactoryProvider<TService> {
  return {
    provide: service,
    inject: [ModuleRef, TransactionManagerRegistry],
    useFactory: async (
      moduleRef: ModuleRef,
      managers: TransactionManagerRegistry,
    ): Promise<TService> =>
      createTransactionalServiceProxy(
        await moduleRef.create(service),
        managers,
        defaultConnectionName,
      ),
  };
}
