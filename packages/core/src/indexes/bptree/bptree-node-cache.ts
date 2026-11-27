import {
  estimateBytes,
  ResourceScope,
  type ResourceReservation,
} from "../../resources/resource-manager.js";
import type { BPlusTreeNode, BPlusTreeNodeIO, NodeId } from "./bptree-node.js";

export class BPlusTreeNodeCache implements BPlusTreeNodeIO {
  private readonly entries = new Map<NodeId, BPlusTreeNode>();
  private readonly sizes = new Map<NodeId, number>();
  private bytes = 0;
  private readonly reservation: ResourceReservation;
  private hits = 0;
  private misses = 0;

  public constructor(
    private readonly source: BPlusTreeNodeIO,
    private readonly capacity = 256,
    private readonly maxBytes = 4 * 1024 * 1024,
    resources = new ResourceScope({}),
  ) {
    this.reservation = resources.reserve({});

    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new RangeError("Invalid cache byte limit");

    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 65_536)
      throw new Error("Invalid B+tree node cache capacity");
  }

  public async read(ref: NodeId): Promise<BPlusTreeNode> {
    const cached = this.entries.get(ref);

    if (cached) {
      this.hits++;
      this.entries.delete(ref);
      this.entries.set(ref, cached);
      return cached;
    }

    this.misses++;

    const node = await this.source.read(ref);

    if (this.entries.has(ref)) return this.entries.get(ref)!;

    const size = estimateBytes(node);

    if (size > this.maxBytes) return node;

    while (this.entries.size >= this.capacity || this.bytes + size > this.maxBytes) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.sizes.get(oldest)!;

      this.sizes.delete(oldest);
      this.entries.delete(oldest);
    }

    this.reservation.resize({ workingBytes: this.bytes + size });

    this.bytes += size;

    this.sizes.set(ref, size);
    this.entries.set(ref, node);

    return node;
  }

  public write(node: BPlusTreeNode): Promise<NodeId> {
    return this.source.write(node);
  }

  public clear(): void {
    this.entries.clear();
    this.sizes.clear();
    this.bytes = 0;
    this.reservation.resize({});
  }

  public getMetrics(): { readonly hits: number; readonly misses: number; readonly bytes: number } {
    return { hits: this.hits, misses: this.misses, bytes: this.bytes };
  }
}
