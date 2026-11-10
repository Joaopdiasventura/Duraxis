import type { StorageDriver } from "@duraxis/storage";
import type { Manifest } from "../../commit/manifest.js";
import { StorageKeyManager } from "../../security/storage-key-manager.js";
import { BPlusTree } from "../bptree/bptree.js";
import { BPlusTreeNodeStore } from "../bptree/bptree-node-store.js";
import type { BatchOperation, BPlusTreeNodeIO, ScanOptions } from "../bptree/bptree-node.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class PrimaryIndex {
  public readonly tree: BPlusTree;

  public constructor(
    private readonly storage: StorageDriver,
    private readonly keys: StorageKeyManager,
    nodes: BPlusTreeNodeIO = new BPlusTreeNodeStore(storage, keys),
  ) {
    this.tree = new BPlusTree(nodes);
  }

  public async getReference(manifest: Manifest, logicalKey: string): Promise<string | null> {
    this.keys.validateLogicalKey(logicalKey);

    const value = await this.tree.get(manifest.primaryRoot, encoder.encode(logicalKey));

    if (value == null) return null;

    const ref = decoder.decode(value);
    this.keys.validateObjectKey(ref);

    return ref;
  }

  public async prepare(
    root: string | null,
    changes: ReadonlyMap<string, string | null>,
  ): Promise<string | null> {
    const operations: BatchOperation[] = [];

    for (const [logicalKey, physicalRef] of changes) {
      this.keys.validateLogicalKey(logicalKey);

      if (physicalRef == null) {
        operations.push({
          type: "delete",
          key: encoder.encode(logicalKey),
        });
      } else {
        this.keys.validateObjectKey(physicalRef);

        operations.push({
          type: "put",
          key: encoder.encode(logicalKey),
          value: encoder.encode(physicalRef),
        });
      }
    }

    return this.tree.batch(root, operations);
  }

  public async readObject(ref: string): Promise<Uint8Array> {
    this.keys.validateObjectKey(ref);

    const object = await this.storage.get(ref);

    if (object == null) throw new Error(`Missing committed object: ${ref}`);

    this.keys.verifyObject(ref, object.data);

    return new Uint8Array(object.data);
  }

  public async read(manifest: Manifest, logicalKey: string): Promise<Uint8Array | null> {
    const ref = await this.getReference(manifest, logicalKey);
    return ref == null ? null : this.readObject(ref);
  }

  public async *scanReferences(
    root: string | null,
    options: ScanOptions = {},
  ): AsyncIterable<{ key: string; ref: string }> {
    for await (const entry of this.tree.scan(root, options)) {
      const key = decoder.decode(entry.key);
      const ref = decoder.decode(entry.value);

      this.keys.validateLogicalKey(key);
      this.keys.validateObjectKey(ref);

      yield { key, ref };
    }
  }
}
