import { Inject } from "@nestjs/common";
import { normalizeDuraxisConnectionName } from "../duraxis.tokens.js";
import { TransactionManagerRegistry } from "./transaction-manager.registry.js";
import { TransactionalProviderNotReadyError } from "./transaction.errors.js";
import { transactionalOptions } from "./transactional.metadata.js";

const MANAGERS = Symbol("Duraxis transaction managers");
const bindings = new WeakMap<object, TransactionManagerRegistry>();
const defaultConnections = new WeakMap<object, string>();
const injectablePrototypes = new WeakSet<object>();
const wrappers = new WeakSet<Function>();
const LIFECYCLE_METHODS = new Set<PropertyKey>([
  "onModuleInit",
  "onApplicationBootstrap",
  "onModuleDestroy",
  "beforeApplicationShutdown",
  "onApplicationShutdown",
]);

export function injectTransactionManagers(prototype: object): void {
  if (injectablePrototypes.has(prototype)) return;

  injectablePrototypes.add(prototype);

  Object.defineProperty(prototype, MANAGERS, {
    set(this: object, managers: TransactionManagerRegistry) {
      bindings.set(this, managers);
      instrumentTransactionalMethods(this);
    },
  });

  Inject(TransactionManagerRegistry)(prototype, MANAGERS);
}

export function setTransactionalDefaultConnection(instance: object, name: string): void {
  defaultConnections.set(instance, name);
}

export function wrapTransactionalMethod(method: Function, property: PropertyKey): Function {
  if (wrappers.has(method)) return method;

  const wrapped = function (this: object, ...arguments_: readonly unknown[]): unknown {
    const methodName = `${this.constructor.name}.${String(property)}`;
    const managers = bindings.get(this);

    if (!managers) throw new TransactionalProviderNotReadyError(methodName);

    const options = transactionalOptions(this, wrapped) ?? {};

    const name = normalizeDuraxisConnectionName(
      options.connectionName ?? defaultConnections.get(this),
    );

    return managers
      .get(name)
      .execute(options, methodName, () => Reflect.apply(method, this, arguments_));
  };

  for (const key of Reflect.getOwnMetadataKeys(method))
    Reflect.defineMetadata(key, Reflect.getOwnMetadata(key, method), wrapped);

  wrappers.add(wrapped);

  return wrapped;
}

export function instrumentTransactionalMethods(target: object): void {
  const visited = new Set<PropertyKey>();

  for (
    let prototype: object | null = target;
    prototype && prototype != Object.prototype;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    for (const property of Reflect.ownKeys(prototype)) {
      if (visited.has(property)) continue;

      visited.add(property);

      if (property == "constructor" || LIFECYCLE_METHODS.has(property)) continue;

      const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
      const method: unknown = descriptor?.value;

      if (typeof method != "function" || !transactionalOptions(target, method)) continue;

      if (wrappers.has(method)) continue;

      Object.defineProperty(target, property, {
        ...descriptor,
        value: wrapTransactionalMethod(method, property),
      });
    }
  }
}
