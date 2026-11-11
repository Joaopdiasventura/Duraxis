import { QueryBuilder, type DuraxisORM, type EntityClass, type Repository } from "@duraxis/orm";
import type { TransactionExecutionContext } from "./transaction-context.manager.js";
import type { TransactionManager } from "./transaction.manager.js";

const WRITE_METHODS = new Set<PropertyKey>(["insert", "save", "update", "upsert", "delete"]);
const BUILDER_METHODS = new Set<PropertyKey>([
  "where",
  "andWhere",
  "orWhere",
  "andWhereGroup",
  "orWhereGroup",
  "notWhere",
  "orderBy",
  "select",
  "limit",
  "cursor",
  "withSignal",
]);
const BUILDER_TERMINALS = new Set<PropertyKey>([
  "getMany",
  "getOne",
  "getCount",
  "getPage",
  "explain",
  "toLogicalQuery",
]);

interface BuilderStep {
  readonly method: PropertyKey;
  readonly arguments: readonly unknown[];
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value == "object" || typeof value == "function") &&
    value != null &&
    typeof Reflect.get(value, "then") == "function"
  );
}

function transactionAwareBuilder<TEntity extends object>(
  entity: EntityClass<TEntity>,
  baseRepository: Repository<TEntity>,
  transactions: TransactionManager,
  captured: TransactionExecutionContext | undefined,
  steps: readonly BuilderStep[] = [],
): QueryBuilder<TEntity> {
  const target = baseRepository.createQueryBuilder();
  return new Proxy(target, {
    get(_target, property) {
      if (BUILDER_METHODS.has(property))
        return (...arguments_: readonly unknown[]) =>
          transactionAwareBuilder(entity, baseRepository, transactions, captured, [
            ...steps,
            { method: property, arguments: arguments_ },
          ]);

      if (BUILDER_TERMINALS.has(property))
        return (...arguments_: readonly unknown[]) => {
          transactions.assertCapturedContext(captured);
          let builder = transactions.resolveRepository(entity, baseRepository).createQueryBuilder();
          for (const step of steps) {
            const method = Reflect.get(builder, step.method);
            if (typeof method != "function") throw new TypeError("Invalid QueryBuilder method");
            const next = Reflect.apply(method, builder, step.arguments);
            if (!(next instanceof QueryBuilder))
              throw new TypeError("QueryBuilder chain returned an invalid value");
            builder = next;
          }
          const terminal = Reflect.get(builder, property);
          if (typeof terminal != "function") throw new TypeError("Invalid QueryBuilder terminal");
          const result: unknown = Reflect.apply(terminal, builder, arguments_);
          return isPromiseLike(result) ? transactions.track(result) : result;
        };

      const value: unknown = Reflect.get(target, property, target);
      return typeof value == "function" ? value.bind(target) : value;
    },
  });
}

export function createTransactionAwareRepository<TEntity extends object>(
  entity: EntityClass<TEntity>,
  baseRepository: Repository<TEntity>,
  transactions: TransactionManager,
): Repository<TEntity> {
  return new Proxy(baseRepository, {
    get(target, property) {
      if (property == "createQueryBuilder")
        return () =>
          transactionAwareBuilder(
            entity,
            baseRepository,
            transactions,
            transactions.currentContext(),
          );

      const effective = transactions.resolveRepository(entity, baseRepository);
      const value: unknown = Reflect.get(effective, property, effective);
      if (typeof value != "function") return value;

      return (...arguments_: readonly unknown[]) => {
        if (WRITE_METHODS.has(property)) transactions.assertWriteAllowed(String(property));
        const current = transactions.resolveRepository(entity, baseRepository);
        const method = Reflect.get(current, property, current);
        if (typeof method != "function") throw new TypeError("Invalid Repository method");
        const result: unknown = Reflect.apply(method, current, arguments_);
        return isPromiseLike(result) ? transactions.track(result) : result;
      };
    },
  });
}

export function createTransactionAwareOrm(
  orm: DuraxisORM,
  transactions: TransactionManager,
): DuraxisORM {
  return new Proxy(orm, {
    get(target, property) {
      if (property == "getRepository")
        return <TEntity extends object>(entity: EntityClass<TEntity>): Repository<TEntity> =>
          transactions.getRepository(entity);
      if (property == "transaction")
        return (...arguments_: readonly unknown[]) => {
          if (transactions.currentContext()) transactions.rejectMixedTransaction();
          const method = Reflect.get(target, property, target);
          if (typeof method != "function") throw new TypeError("Invalid ORM transaction method");
          return Reflect.apply(method, target, arguments_);
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value == "function" ? value.bind(target) : value;
    },
  });
}
