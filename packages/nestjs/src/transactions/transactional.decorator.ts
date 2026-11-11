import type { TransactionalOptions } from "./transaction.types.js";

export const TRANSACTIONAL_METADATA = Symbol.for("@duraxis/nestjs/transactional");

export function Transactional(
  options: TransactionalOptions = {},
): ClassDecorator & MethodDecorator {
  return (
    target: object | Function,
    _propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) => {
    const metadataTarget = descriptor?.value ?? target;
    Reflect.defineMetadata(TRANSACTIONAL_METADATA, Object.freeze({ ...options }), metadataTarget);
  };
}

/** Alias of `@Transactional()`. It is unrelated to `Transaction` from `@duraxis/core`. */
export const Transaction = Transactional;

export function transactionalOptions(
  instance: object,
  method: Function,
): TransactionalOptions | undefined {
  const classOptions = Reflect.getMetadata(TRANSACTIONAL_METADATA, instance.constructor) as
    TransactionalOptions | undefined;
  const methodOptions = Reflect.getMetadata(TRANSACTIONAL_METADATA, method) as
    TransactionalOptions | undefined;
  if (!classOptions && !methodOptions) return undefined;
  return { ...classOptions, ...methodOptions };
}
