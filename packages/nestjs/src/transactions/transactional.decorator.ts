import type { TransactionalOptions } from "./transaction.types.js";
import {
  injectTransactionManagers,
  instrumentTransactionalMethods,
  wrapTransactionalMethod,
} from "./transactional.instrumentation.js";
import { TRANSACTIONAL_METADATA } from "./transactional.metadata.js";

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
    if (descriptor && _propertyKey != null) {
      if (typeof descriptor.value != "function" || typeof target == "function")
        throw new TypeError("@Transactional() requires an instance method");
      injectTransactionManagers(target);
      descriptor.value = wrapTransactionalMethod(descriptor.value, _propertyKey);
    } else if (typeof target == "function") {
      injectTransactionManagers(target.prototype);
      instrumentTransactionalMethods(target.prototype);
    }
  };
}
