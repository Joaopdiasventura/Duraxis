import type { StorageDriver } from "@duraxis/storage";

import {
  parseRecordKey,
  decodeDocument,
  indexedValue,
  indexId,
} from "../catalog/collection-schema.js";
import type { Manifest } from "../commit/manifest.js";
import { encodeSecondaryKey } from "./index-key.js";
import { PrimaryIndex } from "./primary/primary-index.js";
import { BPlusTree } from "./bptree/bptree.js";
import { BPlusTreeNodeStore } from "./bptree/bptree-node-store.js";
import { BPlusTreeValidator } from "./bptree/bptree-validator.js";
import { StorageKeyManager } from "../security/storage-key-manager.js";
const decoder = new TextDecoder();

export class IndexConsistencyChecker {
  private readonly primary: PrimaryIndex;
  private readonly nodes: BPlusTreeNodeStore;

  public constructor(storage: StorageDriver, keys: StorageKeyManager) {
    this.primary = new PrimaryIndex(storage, keys);
    this.nodes = new BPlusTreeNodeStore(storage, keys);
  }

  public async verify(manifest: Manifest): Promise<number> {
    const roots = [manifest.primaryRoot, ...manifest.indexRoots.values()].filter(
      (root): root is string => typeof root == "string",
    );

    const validator = new BPlusTreeValidator(this.nodes);

    for (const root of roots) {
      const result = await validator.validate(root);
      if (!result.valid) throw new Error(`Invalid index tree ${root}: ${result.errors.join("; ")}`);
    }

    const tree = new BPlusTree(this.nodes);
    let checked = 0;

    for (const [collection, schema] of manifest.catalog)
      for (const index of schema.indexes) {
        const name = indexId(collection, index.name);

        if (!manifest.indexRoots.has(name)) throw new Error(`Missing index metadata: ${name}`);

        const expected = new Map<string, string>();

        for await (const record of this.primary.scanReferences(manifest.primaryRoot ?? null)) {
          const parsed = parseRecordKey(record.key);

          if (!parsed || parsed.collection != collection) continue;

          const document = decodeDocument(await this.primary.readObject(record.ref));

          const value = indexedValue(document, index.field);

          if (value == undefined) continue;

          const key = encodeSecondaryKey(value, index.unique ? undefined : parsed.id);

          const hex = Buffer.from(key).toString("hex");

          if (index.unique && expected.has(hex) && expected.get(hex) != parsed.id)
            throw new Error(`Duplicate indexed value: ${name}`);

          expected.set(hex, parsed.id);
        }

        const root = manifest.indexRoots.get(name);
        const actual = new Map<string, string>();

        for await (const entry of tree.scan(root!))
          actual.set(Buffer.from(entry.key).toString("hex"), decoder.decode(entry.value));

        if (actual.size != expected.size) throw new Error(`Index cardinality mismatch: ${name}`);

        for (const [key, id] of expected)
          if (actual.get(key) != id) throw new Error(`Index entry mismatch: ${name}`);

        checked++;
      }

    return checked;
  }
}
