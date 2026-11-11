import type { BPlusTreeNode, BPlusTreeNodeIO, NodeId } from "./bptree-node.js";

/** Query-scoped LRU for already integrity-checked immutable nodes. */
export class BPlusTreeNodeCache implements BPlusTreeNodeIO {
  private readonly entries = new Map<NodeId, BPlusTreeNode>();
  private hits = 0;
  private misses = 0;

  public constructor(
    private readonly source: BPlusTreeNodeIO,
    private readonly capacity = 256,
  ) {
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
    this.entries.set(ref, node);
    if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    return node;
  }

  public write(node: BPlusTreeNode): Promise<NodeId> {
    return this.source.write(node);
  }

  public clear(): void {
    this.entries.clear();
  }

  public getMetrics(): { readonly hits: number; readonly misses: number } {
    return { hits: this.hits, misses: this.misses };
  }
}
