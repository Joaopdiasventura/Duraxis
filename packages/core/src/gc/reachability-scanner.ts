import type { StorageDriver } from "@duraxis/storage";
import type { Snapshot } from "../commit/manifest.js";
import { StorageKeyManager } from "../security/storage-key-manager.js";
import { BPlusTreeNodeStore } from "../indexes/bptree/bptree-node-store.js";
import { PrimaryIndex } from "../indexes/primary/primary-index.js";
import { ResourceExhaustedError } from "../resources/resource-manager.js";

export interface ReachabilityOptions {
  readonly maxReferences?: number;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

const MAX_REFERENCES = 100_000;
const MAX_BYTES = 32 * 1024 * 1024;

export interface ReachabilityScanner {
  scan(snapshot: Snapshot, options?: ReachabilityOptions): Promise<ReadonlySet<string>>;
}

export class ManifestReachabilityScanner implements ReachabilityScanner {
  private readonly nodes: BPlusTreeNodeStore;
  private readonly primary: PrimaryIndex;

  public constructor(
    private readonly keys: StorageKeyManager,
    storage: StorageDriver,
  ) {
    this.nodes = new BPlusTreeNodeStore(storage, keys);
    this.primary = new PrimaryIndex(storage, keys);
  }

  public async scan(
    snapshot: Snapshot,
    options: ReachabilityOptions = {},
  ): Promise<ReadonlySet<string>> {
    const maximum = options.maxReferences ?? MAX_REFERENCES;
    const maxBytes = options.maxBytes ?? MAX_BYTES;

    const reachable = new Set<string>();

    let bytes = 0;

    const add = (ref: string) => {
      if (reachable.has(ref)) return;

      const size = ref.length * 2 + 64;

      if (reachable.size >= maximum || bytes + size > maxBytes)
        throw new ResourceExhaustedError("gcReachability", maxBytes);

      bytes += size;
      reachable.add(ref);
    };

    const path = new Set<string>();

    const visit = async (ref: string, depth: number): Promise<void> => {
      options.signal?.throwIfAborted();

      if (path.has(ref) || depth >= 128)
        throw new Error("Invalid B+tree cycle or depth during reachability scan");

      if (reachable.has(ref)) return;

      this.keys.validateIndexNodeKey(ref);
      add(ref);
      path.add(ref);

      try {
        const node = await this.nodes.read(ref);

        if (node.type == "internal")
          for (const child of node.children) await visit(child, depth + 1);
      } finally {
        path.delete(ref);
      }
    };

    if (snapshot.manifest.primaryRoot) await visit(snapshot.manifest.primaryRoot, 0);

    for (const root of snapshot.manifest.indexRoots.values()) if (root) await visit(root, 0);

    for await (const entry of this.primary.scanReferences(snapshot.manifest.primaryRoot)) {
      options.signal?.throwIfAborted();
      add(entry.ref);
    }

    return reachable;
  }
}
