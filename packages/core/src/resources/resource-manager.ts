export type Resource =
  | "workingBytes"
  | "writeBytes"
  | "writes"
  | "resultRows"
  | "resultBytes"
  | "transactions"
  | "queries"
  | "snapshots"
  | "iterators"
  | "pendingOperations"
  | "queuedOperations"
  | "spillBytes";

export type ResourceAmounts = Partial<Record<Resource, number>>;

export interface ResourceLimits {
  readonly maxConcurrentTransactions: number;
  readonly maxConcurrentQueries: number;
  readonly maxOpenSnapshots: number;
  readonly maxOpenIterators: number;
  readonly maxPendingOperations: number;
  readonly maxQueuedOperations: number;
  readonly maxPendingWrites: number;
  readonly maxPendingWriteBytes: number;
  readonly maxResultRows: number;
  readonly maxResultBytes: number;
  readonly maxQueryWorkingBytes: number;
  readonly maxTransactionWorkingBytes: number;
  readonly maxDatabaseWorkingBytes: number;
  readonly maxStorageReadBytes: number;
  readonly maxDocumentBytes: number;
  readonly maxDocumentDepth: number;
  readonly maxPredicateDepth: number;
  readonly maxPredicateNodes: number;
  readonly maxTransactionDurationMs: number;
  readonly maxQueryDurationMs: number;
  readonly maxSnapshotLifetimeMs: number;
  readonly maxSpillBytes: number;
}

export const DEFAULT_RESOURCE_LIMITS: Readonly<ResourceLimits> = Object.freeze({
  maxQueuedOperations: 64,
  maxConcurrentTransactions: 64,
  maxConcurrentQueries: 64,
  maxOpenSnapshots: 128,
  maxOpenIterators: 256,
  maxPendingOperations: 256,
  maxPendingWrites: 100_000,
  maxPendingWriteBytes: 64 * 1024 * 1024,
  maxResultRows: 10_000,
  maxResultBytes: 16 * 1024 * 1024,
  maxQueryWorkingBytes: 32 * 1024 * 1024,
  maxTransactionWorkingBytes: 128 * 1024 * 1024,
  maxDatabaseWorkingBytes: 512 * 1024 * 1024,
  maxDocumentBytes: 1024 * 1024,
  maxStorageReadBytes: 4 * 1024 * 1024,
  maxDocumentDepth: 64,
  maxPredicateDepth: 32,
  maxPredicateNodes: 4096,
  maxTransactionDurationMs: 60_000,
  maxQueryDurationMs: 30_000,
  maxSnapshotLifetimeMs: 60_000,
  maxSpillBytes: 256 * 1024 * 1024,
});

export class ResourceExhaustedError extends Error {
  public constructor(
    public readonly resource: string,
    public readonly limit: number,
  ) {
    super(
      `Duraxis resource limit exceeded: ${resource} (limit ${limit}); reduce the workload or explicitly configure a larger budget`,
    );
    this.name = "ResourceExhaustedError";
  }
}

export class OperationCancelledError extends Error {
  public constructor(message = "Duraxis operation cancelled or deadline exceeded") {
    super(message);
    this.name = "OperationCancelledError";
  }
}

export function resourceLimits(options: Partial<ResourceLimits> = {}): Readonly<ResourceLimits> {
  const result = { ...DEFAULT_RESOURCE_LIMITS, ...options };

  for (const [name, value] of Object.entries(result))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(`Invalid resource limit: ${name}`);

  return Object.freeze(result);
}

export interface ResourceReservation {
  resize(amounts: ResourceAmounts): void;
  release(): void;
}

export class ResourceScope {
  private readonly usage: ResourceAmounts = {};
  private readonly high: ResourceAmounts = {};
  private readonly children = new Set<ResourceScope>();
  private closed = false;

  public constructor(
    private readonly limits: ResourceAmounts,
    private readonly parent?: ResourceScope,
  ) {
    parent?.children.add(this);
  }

  public child(limits: ResourceAmounts): ResourceScope {
    this.assertOpen();
    return new ResourceScope(limits, this);
  }

  private assertOpen(): void {
    if (this.closed) throw new OperationCancelledError("Resource scope is closed");
  }

  private change(delta: ResourceAmounts): void {
    const chain: ResourceScope[] = [];

    for (let scope: ResourceScope | undefined = this; scope; scope = scope.parent) {
      scope.assertOpen();
      chain.push(scope);

      for (const [key, value] of Object.entries(delta) as [Resource, number][]) {
        const next = (scope.usage[key] ?? 0) + value;

        if (next < 0) throw new Error("Resource accounting underflow");

        if (next > (scope.limits[key] ?? Number.MAX_SAFE_INTEGER))
          throw new ResourceExhaustedError(key, scope.limits[key]!);
      }
    }

    for (const scope of chain)
      for (const [key, value] of Object.entries(delta) as [Resource, number][]) {
        scope.usage[key] = (scope.usage[key] ?? 0) + value;
        scope.high[key] = Math.max(scope.high[key] ?? 0, scope.usage[key]!);
      }
  }

  public reserve(initial: ResourceAmounts): ResourceReservation {
    let held: ResourceAmounts = {};
    let released = false;

    const resize = (amounts: ResourceAmounts) => {
      if (released || this.closed) throw new OperationCancelledError("Reservation is closed");
      const delta: ResourceAmounts = {};

      for (const key of new Set([...Object.keys(held), ...Object.keys(amounts)]) as Set<Resource>) {
        const amount = amounts[key] ?? 0;

        if (!Number.isSafeInteger(amount) || amount < 0)
          throw new RangeError("Invalid resource reservation");

        delta[key] = amount - (held[key] ?? 0);
      }

      this.change(delta);
      held = { ...amounts };
    };

    resize(initial);

    return {
      resize,
      release: () => {
        if (released) return;
        released = true;
        if (!this.closed)
          this.change(
            Object.fromEntries(Object.entries(held).map(([key, value]) => [key, -value])),
          );
        held = {};
      },
    };
  }

  public metrics(): { current: ResourceAmounts; highWater: ResourceAmounts } {
    return { current: { ...this.usage }, highWater: { ...this.high } };
  }

  public close(): void {
    if (this.closed) return;
    for (const child of [...this.children]) child.close();

    this.change(
      Object.fromEntries(Object.entries(this.usage).map(([key, value]) => [key, -value])),
    );

    this.closed = true;
    this.parent?.children.delete(this);
  }
}

export function databaseScope(limits: ResourceLimits): ResourceScope {
  return new ResourceScope({
    workingBytes: limits.maxDatabaseWorkingBytes,
    transactions: limits.maxConcurrentTransactions,
    queries: limits.maxConcurrentQueries,
    snapshots: limits.maxOpenSnapshots,
    iterators: limits.maxOpenIterators,
    pendingOperations: limits.maxPendingOperations,
    queuedOperations: limits.maxQueuedOperations,
  });
}

export function estimateBytes(value: unknown, maximum = 128 * 1024 * 1024, maxDepth = 64): number {
  let bytes = 0;

  const ancestors = new Set<object>();

  const visit = (item: unknown, depth: number): void => {
    if (depth > maxDepth) throw new ResourceExhaustedError("documentDepth", maxDepth);
    if (typeof item == "string") bytes += item.length * 2 + 24;
    else if (item == null || typeof item != "object") bytes += 16;
    else if (item instanceof Uint8Array) bytes += item.byteLength + 64;
    else if (item instanceof Date) bytes += 32;
    else {
      if (ancestors.has(item)) throw new TypeError("Cyclic values are not supported");

      ancestors.add(item);
      bytes += 64;

      for (const key in item)
        if (Object.hasOwn(item, key)) {
          if (key == "__proto__") throw new TypeError("Unsafe object property");

          const descriptor = Object.getOwnPropertyDescriptor(item, key)!;

          if (!("value" in descriptor))
            throw new TypeError("Accessor properties are not supported");

          bytes += key.length * 2 + 32;

          visit(descriptor.value, depth + 1);

          if (bytes > maximum) throw new ResourceExhaustedError("workingBytes", maximum);
        }

      ancestors.delete(item);
    }

    if (bytes > maximum) throw new ResourceExhaustedError("workingBytes", maximum);
  };

  visit(value, 0);

  return bytes;
}

export function materialize<T>(
  scope: ResourceScope,
  limits: ResourceLimits,
): { add(value: T): void; close(): void } {
  const reservation = scope.reserve({});

  let rows = 0;
  let bytes = 0;
  let working = 0;

  return {
    add(value) {
      if (rows + 1 > limits.maxResultRows)
        throw new ResourceExhaustedError("resultRows", limits.maxResultRows);

      const size = estimateBytes(value, limits.maxQueryWorkingBytes, limits.maxDocumentDepth + 4);

      reservation.resize({ workingBytes: working + size * 8 });

      let encoded: string | undefined;

      try {
        encoded = JSON.stringify(value);
      } finally {
        reservation.resize({ workingBytes: working + size });
      }

      if (encoded === undefined) throw new TypeError("Result is not JSON serializable");

      const next = bytes + Buffer.byteLength(encoded);

      if (next > limits.maxResultBytes)
        throw new ResourceExhaustedError("resultBytes", limits.maxResultBytes);

      working += size;
      bytes = next;
      rows++;
    },
    close: () => reservation.release(),
  };
}
