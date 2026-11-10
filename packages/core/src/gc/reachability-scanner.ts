import type { StorageDriver } from "@duraxis/storage";
import type { Snapshot } from "../commit/manifest.js";

import { StorageKeyManager } from "../security/storage-key-manager.js";
import { BPlusTreeNodeStore } from "../indexes/bptree/bptree-node-store.js";
import { BPlusTreeValidator } from "../indexes/bptree/bptree-validator.js";
import { PrimaryIndex } from "../indexes/primary/primary-index.js";

export interface ReachabilityScanner {
  scan(snapshot: Snapshot): Promise<ReadonlySet<string>>;
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

  public async scan(snapshot: Snapshot): Promise<ReadonlySet<string>> {
    const reachable = new Set<string>();

    const roots = new Set<string>();

    if (snapshot.manifest.primaryRoot != null) roots.add(snapshot.manifest.primaryRoot);

    for (const root of snapshot.manifest.indexRoots.values()) if (root != null) roots.add(root);

    const validator = new BPlusTreeValidator(this.nodes);

    for (const root of roots) {
      this.keys.validateIndexNodeKey(root);
      const references = await validator.reachableNodes(root);
      for (const ref of references) reachable.add(ref);
    }

    for await (const entry of this.primary.scanReferences(snapshot.manifest.primaryRoot))
      reachable.add(entry.ref);

    return reachable;
  }
}
