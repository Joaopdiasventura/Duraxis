import { randomUUID } from "node:crypto";

import type { BPlusTreeNode, BPlusTreeNodeIO, NodeId } from "./bptree-node.js";

import { encodeNode } from "./bptree-codec.js";

export class BPlusTreeBatchStore implements BPlusTreeNodeIO {
  private readonly staged = new Map<NodeId, BPlusTreeNode>();

  private readonly prefix = `@duraxis-staged:${randomUUID()}:`;

  public constructor(private readonly backing: BPlusTreeNodeIO) {}

  public async read(ref: NodeId): Promise<BPlusTreeNode> {
    if (ref.startsWith("@duraxis-staged:")) {
      const node = this.staged.get(ref);
      if (!node) throw new Error("Unknown or foreign staged B+tree node");
      return node;
    }

    return this.backing.read(ref);
  }

  public async write(node: BPlusTreeNode): Promise<NodeId> {
    const clone = JSON.parse(Buffer.from(encodeNode(node)).toString("utf8")) as BPlusTreeNode;
    const id = `${this.prefix}${randomUUID()}`;
    this.staged.set(id, clone);
    return id;
  }

  public async flush(root: NodeId | null): Promise<NodeId | null> {
    if (root == null) return null;

    const memo = new Map<NodeId, NodeId>();
    const visiting = new Set<NodeId>();

    const resolve = async (id: NodeId): Promise<NodeId> => {
      if (!id.startsWith("@duraxis-staged:")) return id;

      const cached = memo.get(id);

      if (cached) return cached;

      if (visiting.has(id)) throw new Error("B+tree staged reference cycle");

      const node = this.staged.get(id);

      if (!node) throw new Error("Unknown or foreign staged B+tree node");

      visiting.add(id);

      try {
        const children: NodeId[] = [];

        if (node.type == "internal")
          for (const child of node.children) children.push(await resolve(child));

        const persisted: BPlusTreeNode =
          node.type == "leaf"
            ? node
            : {
                type: "internal",
                keys: [...node.keys],
                children,
              };

        const physical = await this.backing.write(persisted);

        memo.set(id, physical);

        return physical;
      } finally {
        visiting.delete(id);
      }
    };

    return resolve(root);
  }
}
