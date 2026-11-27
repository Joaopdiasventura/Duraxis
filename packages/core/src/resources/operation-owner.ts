import type { StorageDriver } from "@duraxis/storage";
import { OperationCancelledError, ResourceScope } from "./resource-manager.js";

export class OperationOwner {
  public readonly controller = new AbortController();
  public readonly storage: StorageDriver;

  private pending = 0;
  private ended = false;
  private disposed = false;
  private publishing = false;

  private readonly timer: ReturnType<typeof setTimeout>;

  public constructor(
    public readonly scope: ResourceScope,
    storage: StorageDriver,
    durationMs: number,
    private readonly onDispose: () => void,
    maxReadBytes = 16 * 1024 * 1024,
  ) {
    this.timer = setTimeout(
      () => this.cancel(new OperationCancelledError("Operation lifetime expired")),
      durationMs,
    );

    this.timer.unref();

    this.storage = {
      capabilities: storage.capabilities,
      get: (key, options) =>
        this.track(async () => {
          const signal = options?.signal
            ? AbortSignal.any([this.signal, options.signal])
            : this.signal;

          const value = await storage.get(key, {
            signal,
            maxBytes: Math.min(maxReadBytes, options?.maxBytes ?? maxReadBytes),
          });

          if (value && value.data.byteLength > maxReadBytes)
            throw new Error("Storage read exceeds configured byte limit");

          return value;
        }, maxReadBytes * 3),
      put: (key, data, options) =>
        this.track(() => storage.put(key, data, options), data.byteLength * 2),
      delete: (key, options) => this.track(() => storage.delete(key, options)),
      list: (prefix) => this.track(() => storage.list(prefix)),
    };
  }

  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public get isDisposed(): boolean {
    return this.disposed;
  }

  public get pendingOperations(): number {
    return this.pending;
  }

  public assertActive(): void {
    this.signal.throwIfAborted();
    if (this.ended) throw new OperationCancelledError("Operation is closed");
  }

  private async track<T>(action: () => Promise<T>, bytes = 0): Promise<T> {
    this.assertActive();

    const lease = this.scope.reserve({ pendingOperations: 1, workingBytes: bytes });
    this.pending++;

    try {
      const value = await action();
      if (!this.publishing) this.signal.throwIfAborted();
      return value;
    } finally {
      lease.release();
      this.pending--;
      this.disposeIfReady();
    }
  }

  public protectPublication(): void {
    this.assertActive();
    this.publishing = true;
    clearTimeout(this.timer);
  }

  public cancel(reason: unknown = new OperationCancelledError()): void {
    if (this.publishing) return;
    if (!this.signal.aborted) this.controller.abort(reason);
    this.finish();
  }

  public finish(): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    this.disposeIfReady();
  }

  private disposeIfReady(): void {
    if (!this.ended || this.pending || this.disposed) return;
    this.disposed = true;
    this.scope.close();
    this.onDispose();
  }

  public holdCleanup(promise: Promise<unknown>): void {
    this.pending++;

    const complete = () => {
      this.pending--;
      this.disposeIfReady();
    };

    promise.then(complete, complete);
  }

  public async wait<T>(promise: Promise<T>): Promise<T> {
    this.assertActive();

    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        cleanup();
        reject(this.signal.reason);
      };

      const cleanup = () => this.signal.removeEventListener("abort", abort);

      this.signal.addEventListener("abort", abort, { once: true });

      promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
      if (this.signal.aborted) abort();
    });
  }
}
