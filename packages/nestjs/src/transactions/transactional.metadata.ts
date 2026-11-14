import type { TransactionalOptions } from "./transaction.types.js";

export const TRANSACTIONAL_METADATA = Symbol.for("@duraxis/nestjs/transactional");

export function transactionalOptions(
  instance: object,
  method: Function,
): TransactionalOptions | undefined {
  const classOptions = Reflect.getMetadata(TRANSACTIONAL_METADATA, instance.constructor) as
    TransactionalOptions | undefined;

  const methodOptions = Reflect.getMetadata(TRANSACTIONAL_METADATA, method) as
    TransactionalOptions | undefined;

  return !classOptions && !methodOptions ? undefined : { ...classOptions, ...methodOptions };
}
