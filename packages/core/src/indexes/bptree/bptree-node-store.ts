import { randomUUID } from "node:crypto";

import type { StorageDriver } from "@duraxis/storage";

import { assertDigest, sha256 } from "../../integrity/integrity.js";

import { StorageKeyManager } from "../../security/storage-key-manager.js";

import type { BPlusTreeNode, BPlusTreeNodeIO, NodeId } from "./bptree-node.js";

import { decodeNode, encodeNode } from "./bptree-codec.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class BPlusTreeNodeStore implements BPlusTreeNodeIO {
  private readonly prefix: string;
  private readonly pattern: RegExp;

  public constructor(
    private readonly storage: StorageDriver,
    keys: StorageKeyManager,
  ) {
    this.prefix = `${keys.namespace}/indexes/nodes/`;
    this.pattern = new RegExp(`^${escapeRegex(this.prefix)}${UUID}-([a-f0-9]{64})$`);
  }

  public get nodePrefix(): string {
    return this.prefix;
  }

  public validateReference(ref: NodeId): void {
    if (!this.pattern.test(ref)) throw new Error("Invalid or foreign B+tree node reference");
  }

  public async read(ref: NodeId): Promise<BPlusTreeNode> {
    this.validateReference(ref);

    const stored = await this.storage.get(ref);

    if (!stored) throw new Error(`Missing B+tree node: ${ref}`);

    assertDigest(stored.data, this.pattern.exec(ref)![1]!);

    const node = decodeNode(stored.data);

    if (node.type == "internal") for (const child of node.children) this.validateReference(child);

    return node;
  }

  public async write(node: BPlusTreeNode): Promise<NodeId> {
    const bytes = encodeNode(node);

    if (node.type == "internal") for (const child of node.children) this.validateReference(child);

    const ref = `${this.prefix}${randomUUID()}-${sha256(bytes)}`;

    const result = await this.storage.put(ref, bytes, {
      condition: {
        type: "if-absent",
      },
    });

    if (!result.success) throw new Error("Unexpected B+tree node collision");

    return ref;
  }
}
