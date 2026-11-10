import type { BPlusTreeNodeIO, EncodedKey, NodeId } from "./bptree-node.js";

import { MAX_NODE_BYTES, nodeSize } from "./bptree-codec.js";

export interface BPlusTreeValidationResult {
  readonly valid: boolean;
  readonly height: number;
  readonly nodeCount: number;
  readonly leafCount: number;
  readonly entryCount: number;
  readonly errors: readonly string[];
}

interface Bounds {
  min: EncodedKey;
  max: EncodedKey;
  height: number;
}

export class BPlusTreeValidator {
  public constructor(
    private readonly nodes: BPlusTreeNodeIO,
    private readonly maxKeys = 32,
    private readonly maxNodeBytes = 64 * 1024,
  ) {
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 3 || maxKeys > 4096)
      throw new Error("Invalid B+tree maximum key count");

    if (!Number.isSafeInteger(maxNodeBytes) || maxNodeBytes < 2048 || maxNodeBytes > MAX_NODE_BYTES)
      throw new Error("Invalid B+tree page byte limit");
  }

  public async validate(root: NodeId | null): Promise<BPlusTreeValidationResult> {
    if (root == null)
      return {
        valid: true,
        height: 0,
        nodeCount: 0,
        leafCount: 0,
        entryCount: 0,
        errors: [],
      };

    const errors: string[] = [];
    const seen = new Set<NodeId>();

    let nodeCount = 0;
    let leafCount = 0;
    let entryCount = 0;

    const visit = async (
      ref: NodeId,
      depth: number,
      lower: EncodedKey | null,
      upper: EncodedKey | null,
    ): Promise<Bounds | null> => {
      if (depth >= 128) {
        errors.push(`Maximum depth exceeded at ${ref}`);
        return null;
      }

      if (seen.has(ref)) {
        errors.push(`Cycle or duplicate node reference: ${ref}`);
        return null;
      }

      seen.add(ref);

      let node;

      try {
        node = await this.nodes.read(ref);
      } catch (error) {
        errors.push(`Unreadable node ${ref}: ${String(error)}`);
        return null;
      }

      nodeCount++;

      if (node.keys.length > this.maxKeys) errors.push(`Too many keys at ${ref}`);

      try {
        if (nodeSize(node) > this.maxNodeBytes) errors.push(`Page size exceeded at ${ref}`);
      } catch (error) {
        errors.push(`Invalid page ${ref}: ${String(error)}`);
      }

      if (!node.keys.length) errors.push(`Empty reachable node: ${ref}`);

      if (node.type == "leaf") {
        leafCount++;
        entryCount += node.keys.length;

        if (!node.keys.length) return null;

        for (const key of node.keys)
          if ((lower != null && key < lower) || (upper != null && key >= upper))
            errors.push(`Leaf key outside subtree bounds: ${ref}`);

        return {
          min: node.keys[0]!,
          max: node.keys[node.keys.length - 1]!,
          height: 1,
        };
      }

      const children: Array<Bounds | null> = [];

      for (let i = 0; i < node.children.length; i++)
        children.push(
          await visit(
            node.children[i]!,
            depth + 1,
            i == 0 ? lower : node.keys[i - 1]!,
            i == node.keys.length ? upper : node.keys[i]!,
          ),
        );

      const validChildren = children.filter((child): child is Bounds => child != null);

      if (validChildren.length != node.children.length) return null;

      const expectedHeight = validChildren[0]!.height;

      for (const child of validChildren)
        if (child.height != expectedHeight) errors.push(`Unequal leaf depth at ${ref}`);

      for (let i = 1; i < validChildren.length; i++) {
        if (validChildren[i]!.min != node.keys[i - 1])
          errors.push(`Incorrect separator at ${ref} index ${i - 1}`);

        if (validChildren[i - 1]!.max >= validChildren[i]!.min)
          errors.push(`Overlapping child key ranges at ${ref}`);
      }

      return {
        min: validChildren[0]!.min,
        max: validChildren[validChildren.length - 1]!.max,
        height: expectedHeight + 1,
      };
    };

    const bounds = await visit(root, 0, null, null);

    return {
      valid: errors.length == 0 && bounds != null,
      height: bounds?.height ?? 0,
      nodeCount,
      leafCount,
      entryCount,
      errors,
    };
  }

  public async reachableNodes(root: NodeId | null): Promise<ReadonlySet<NodeId>> {
    const found = new Set<NodeId>();

    const walk = async (ref: NodeId, depth: number): Promise<void> => {
      if (depth >= 128) throw new Error("B+tree maximum depth exceeded");

      if (found.has(ref)) throw new Error("B+tree cycle or duplicate node reference");

      found.add(ref);

      const node = await this.nodes.read(ref);

      if (node.type == "internal") for (const child of node.children) await walk(child, depth + 1);
    };

    if (root != null) await walk(root, 0);

    return found;
  }
}
