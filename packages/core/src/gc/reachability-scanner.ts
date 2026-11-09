import type { Snapshot } from "../commit/manifest.js";

import { StorageKeyManager } from "../security/storage-key-manager.js";

export interface ReachabilityScanner {
  scan(snapshot: Snapshot): Promise<ReadonlySet<string>>;
}

export class ManifestReachabilityScanner implements ReachabilityScanner {
  public constructor(private readonly keys: StorageKeyManager) {}

  public async scan(snapshot: Snapshot): Promise<ReadonlySet<string>> {
    const reachable = new Set<string>();

    for (const physicalKey of snapshot.manifest.entries.values()) {
      this.keys.validateObjectKey(physicalKey);
      reachable.add(physicalKey);
    }

    return reachable;
  }
}
