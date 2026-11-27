import {
  ResourceExhaustedError,
  type ResourceLimits,
  type ResourceScope,
} from "./resource-manager.js";
import type { PendingWrite } from "../transactions/transaction.js";

export class PreparedWrites extends Map<string, PendingWrite> {
  private bytes = 0;
  private encodedBytes = 0;

  private readonly reservation;

  public constructor(
    scope: ResourceScope,
    private readonly limits: ResourceLimits,
    source: ReadonlyMap<string, PendingWrite>,
  ) {
    super();
    this.reservation = scope.reserve({});
    for (const [key, value] of source) this.set(key, value);
  }

  private sizeOf(key: string, value: PendingWrite): number {
    return key.length * 2 + 512 + (value.type === "put" ? value.data.byteLength * 8 : 0);
  }

  public override set(key: string, value: PendingWrite): this {
    const previous = this.get(key);

    if (!previous && this.size >= this.limits.maxPendingWrites)
      throw new ResourceExhaustedError("writes", this.limits.maxPendingWrites);

    if (value.type === "put" && value.data.byteLength > this.limits.maxDocumentBytes)
      throw new ResourceExhaustedError("documentBytes", this.limits.maxDocumentBytes);

    const next = this.bytes - (previous ? this.sizeOf(key, previous) : 0) + this.sizeOf(key, value);

    const encoded =
      this.encodedBytes -
      (previous?.type === "put" ? previous.data.byteLength : 0) +
      (value.type === "put" ? value.data.byteLength : 0);

    if (encoded > this.limits.maxPendingWriteBytes)
      throw new ResourceExhaustedError("preparedWriteBytes", this.limits.maxPendingWriteBytes);

    this.reservation.resize({ workingBytes: next });

    this.bytes = next;
    this.encodedBytes = encoded;

    return super.set(key, value);
  }
}
