import type {
  BatchOperation,
  BPlusTreeNode,
  BPlusTreeNodeIO,
  EncodedKey,
  IndexEntry,
  InternalNode,
  LeafNode,
  NodeId,
  ScanOptions,
} from "./bptree-node.js";

import {
  decodeIndexKey,
  decodeIndexValue,
  encodeIndexKey,
  encodeIndexValue,
  lowerBound,
  MAX_NODE_BYTES,
  nodeSize,
  upperBound,
} from "./bptree-codec.js";

import { BPlusTreeBatchStore } from "./bptree-batch-store.js";

export interface BPlusTreeOptions {
  readonly maxKeys?: number;
  readonly maxNodeBytes?: number;
}

interface Change {
  readonly ref: NodeId;
  readonly changed: boolean;
  readonly split?: {
    separator: EncodedKey;
    right: NodeId;
  };
}

const MAX_DEPTH = 128;

export class BPlusTree {
  private readonly maxKeys: number;
  private readonly maxNodeBytes: number;

  public constructor(
    private readonly nodes: BPlusTreeNodeIO,
    options: BPlusTreeOptions = {},
  ) {
    this.maxKeys = options.maxKeys ?? 32;
    this.maxNodeBytes = options.maxNodeBytes ?? 64 * 1024;

    if (!Number.isSafeInteger(this.maxKeys) || this.maxKeys < 3 || this.maxKeys > 4096)
      throw new Error("Invalid B+tree maximum key count");

    if (
      !Number.isSafeInteger(this.maxNodeBytes) ||
      this.maxNodeBytes < 2048 ||
      this.maxNodeBytes > MAX_NODE_BYTES
    )
      throw new Error("Invalid B+tree page byte limit");
  }

  public async get(root: NodeId | null, key: Uint8Array): Promise<Uint8Array | null> {
    const target = encodeIndexKey(key);

    if (root == null) return null;

    let cursor = root;
    const seen = new Set<NodeId>();

    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      if (seen.has(cursor)) throw new Error("B+tree reference cycle detected");

      seen.add(cursor);

      const node = await this.nodes.read(cursor);

      if (node.type == "leaf") {
        const position = lowerBound(node.keys, target);
        return node.keys[position] == target ? decodeIndexValue(node.values[position]!) : null;
      }

      cursor = node.children[upperBound(node.keys, target)]!;
    }

    throw new Error("B+tree maximum depth exceeded");
  }

  public async put(root: NodeId | null, key: Uint8Array, value: Uint8Array): Promise<NodeId> {
    const result = await this.batch(root, [
      {
        type: "put",
        key,
        value,
      },
    ]);

    if (!result) throw new Error("Unexpected empty B+tree after put");

    return result;
  }

  public async delete(root: NodeId | null, key: Uint8Array): Promise<NodeId | null> {
    return this.batch(root, [
      {
        type: "delete",
        key,
      },
    ]);
  }

  public async batch(
    root: NodeId | null,
    operations: readonly BatchOperation[],
  ): Promise<NodeId | null> {
    const stage = new BPlusTreeBatchStore(this.nodes);

    const working = new BPlusTree(stage, {
      maxKeys: this.maxKeys,
      maxNodeBytes: this.maxNodeBytes,
    });

    let next = root;

    for (const op of operations) {
      if (op.type == "put") {
        const key = encodeIndexKey(op.key);
        const value = encodeIndexValue(op.value);

        next = await working.insertRoot(next, key, value);
      } else next = await working.removeRoot(next, encodeIndexKey(op.key));
    }

    return stage.flush(next);
  }

  public async *scan(root: NodeId | null, options: ScanOptions = {}): AsyncIterable<IndexEntry> {
    if (options.gt != undefined && options.gte != undefined)
      throw new Error("Use either gt or gte");

    if (options.lt != undefined && options.lte != undefined)
      throw new Error("Use either lt or lte");

    const lower =
      options.gt != undefined
        ? encodeIndexKey(options.gt)
        : options.gte != undefined
          ? encodeIndexKey(options.gte)
          : null;

    const upper =
      options.lt != undefined
        ? encodeIndexKey(options.lt)
        : options.lte != undefined
          ? encodeIndexKey(options.lte)
          : null;

    const limit = options.limit ?? Number.MAX_SAFE_INTEGER;

    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid scan limit");

    if (root == null || limit == 0) return;

    let count = 0;

    for await (const entry of this.traverse(root, lower, upper, 0, new Set())) {
      const key = encodeIndexKey(entry.key);
      if (lower != null && (key < lower || (key == lower && options.gt != undefined))) continue;
      if (upper != null && (key > upper || (key == upper && options.lt != undefined))) return;

      yield entry;
      if (++count >= limit) return;
    }
  }

  private fits(node: BPlusTreeNode): boolean {
    if (node.keys.length > this.maxKeys) return false;

    try {
      return nodeSize(node) <= this.maxNodeBytes;
    } catch (error) {
      if (error instanceof Error && error.message.includes("size limit")) return false;
      throw error;
    }
  }

  private async persist(node: BPlusTreeNode): Promise<NodeId> {
    if (!this.fits(node)) throw new Error("B+tree node exceeds configured page capacity");
    return this.nodes.write(node);
  }

  private async insertRoot(root: NodeId | null, key: EncodedKey, value: string): Promise<NodeId> {
    if (root == null)
      return this.persist({
        type: "leaf",
        keys: [key],
        values: [value],
      });

    const result = await this.insert(root, key, value, 0, new Set());

    if (!result.split) return result.ref;

    return this.persist({
      type: "internal",
      keys: [result.split.separator],
      children: [result.ref, result.split.right],
    });
  }

  private async insert(
    ref: NodeId,
    key: EncodedKey,
    value: string,
    depth: number,
    ancestors: Set<NodeId>,
  ): Promise<Change> {
    this.enter(ref, depth, ancestors);

    try {
      const node = await this.nodes.read(ref);

      if (node.type == "leaf") {
        const keys = [...node.keys];
        const values = [...node.values];

        const pos = lowerBound(keys, key);

        if (keys[pos] == key) {
          if (values[pos] == value)
            return {
              ref,
              changed: false,
            };

          values[pos] = value;
        } else {
          keys.splice(pos, 0, key);
          values.splice(pos, 0, value);
        }

        const updated: LeafNode = {
          type: "leaf",
          keys,
          values,
        };

        if (this.fits(updated))
          return {
            ref: await this.persist(updated),
            changed: true,
          };

        const cuts = Array.from({ length: keys.length - 1 }, (_, i) => i + 1).sort(
          (a, b) => Math.abs(a - keys.length / 2) - Math.abs(b - keys.length / 2),
        );

        for (const cut of cuts) {
          const left: LeafNode = {
            type: "leaf",
            keys: keys.slice(0, cut),
            values: values.slice(0, cut),
          };

          const right: LeafNode = {
            type: "leaf",
            keys: keys.slice(cut),
            values: values.slice(cut),
          };

          if (!this.fits(left) || !this.fits(right)) continue;

          return {
            changed: true,
            ref: await this.persist(left),
            split: {
              separator: right.keys[0]!,
              right: await this.persist(right),
            },
          };
        }

        throw new Error("Cannot split B+tree leaf within page capacity");
      }

      const index = upperBound(node.keys, key);
      const modified = await this.insert(node.children[index]!, key, value, depth + 1, ancestors);

      if (!modified.changed)
        return {
          ref,
          changed: false,
        };

      const keys = [...node.keys];
      const children = [...node.children];

      children[index] = modified.ref;

      if (modified.split) {
        keys.splice(index, 0, modified.split.separator);
        children.splice(index + 1, 0, modified.split.right);
      }

      const updated: InternalNode = {
        type: "internal",
        keys,
        children,
      };

      if (this.fits(updated))
        return {
          ref: await this.persist(updated),
          changed: true,
        };

      const cuts = Array.from({ length: keys.length - 2 }, (_, i) => i + 1).sort(
        (a, b) => Math.abs(a - keys.length / 2) - Math.abs(b - keys.length / 2),
      );

      for (const cut of cuts) {
        const left: InternalNode = {
          type: "internal",
          keys: keys.slice(0, cut),
          children: children.slice(0, cut + 1),
        };

        const right: InternalNode = {
          type: "internal",
          keys: keys.slice(cut + 1),
          children: children.slice(cut + 1),
        };

        if (!this.fits(left) || !this.fits(right)) continue;

        return {
          changed: true,
          ref: await this.persist(left),
          split: {
            separator: keys[cut]!,
            right: await this.persist(right),
          },
        };
      }

      throw new Error("Cannot split B+tree internal node within page capacity");
    } finally {
      ancestors.delete(ref);
    }
  }

  private async removeRoot(root: NodeId | null, key: EncodedKey): Promise<NodeId | null> {
    if (root == null) return null;

    const changed = await this.remove(root, key, 0, new Set());

    if (!changed.changed) return root;

    let ref = changed.ref;

    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const node = await this.nodes.read(ref);

      if (node.type == "leaf") return node.keys.length ? ref : null;

      if (node.keys.length != 0) return ref;

      ref = node.children[0]!;
    }

    throw new Error("B+tree maximum depth exceeded");
  }

  private async remove(
    ref: NodeId,
    key: EncodedKey,
    depth: number,
    ancestors: Set<NodeId>,
  ): Promise<Change> {
    this.enter(ref, depth, ancestors);

    try {
      const node = await this.nodes.read(ref);

      if (node.type == "leaf") {
        const index = lowerBound(node.keys, key);

        if (node.keys[index] != key)
          return {
            ref,
            changed: false,
          };

        const keys = [...node.keys];
        const values = [...node.values];

        keys.splice(index, 1);
        values.splice(index, 1);

        return {
          ref: await this.persist({
            type: "leaf",
            keys,
            values,
          }),
          changed: true,
        };
      }

      const index = upperBound(node.keys, key);
      const changed = await this.remove(node.children[index]!, key, depth + 1, ancestors);

      if (!changed.changed)
        return {
          ref,
          changed: false,
        };

      const children = [...node.children];

      children[index] = changed.ref;

      const child = await this.nodes.read(changed.ref);

      if (child.keys.length == 0 && children.length > 1) await this.rebalance(children, index);

      const rebuilt = await this.buildInternal(children);

      return {
        ref: await this.persist(rebuilt),
        changed: true,
      };
    } finally {
      ancestors.delete(ref);
    }
  }

  private async rebalance(children: NodeId[], index: number): Promise<void> {
    const leftIndex = index > 0 ? index - 1 : 0;
    const left = await this.nodes.read(children[leftIndex]!);
    const right = await this.nodes.read(children[leftIndex + 1]!);

    if (left.type != right.type) throw new Error("B+tree sibling type mismatch");

    if (left.type == "leaf" && right.type == "leaf") {
      const keys = [...left.keys, ...right.keys];
      const values = [...left.values, ...right.values];

      const merged: LeafNode = {
        type: "leaf",
        keys,
        values,
      };

      if (this.fits(merged)) {
        children.splice(leftIndex, 2, await this.persist(merged));
        return;
      }

      for (let cut = 1; cut < keys.length; cut++) {
        const a: LeafNode = {
          type: "leaf",
          keys: keys.slice(0, cut),
          values: values.slice(0, cut),
        };

        const b: LeafNode = {
          type: "leaf",
          keys: keys.slice(cut),
          values: values.slice(cut),
        };

        if (!this.fits(a) || !this.fits(b)) continue;

        children.splice(leftIndex, 2, await this.persist(a), await this.persist(b));

        return;
      }

      throw new Error("Cannot rebalance B+tree leaf within page capacity");
    }

    if (left.type == "internal" && right.type == "internal") {
      const refs = [...left.children, ...right.children];
      const merged = await this.buildInternal(refs);

      if (this.fits(merged)) {
        children.splice(leftIndex, 2, await this.persist(merged));
        return;
      }

      for (let cut = 2; cut <= refs.length - 2; cut++) {
        const a = await this.buildInternal(refs.slice(0, cut));
        const b = await this.buildInternal(refs.slice(cut));

        if (!this.fits(a) || !this.fits(b)) continue;

        children.splice(leftIndex, 2, await this.persist(a), await this.persist(b));
        return;
      }

      throw new Error("Cannot rebalance B+tree internal node within page capacity");
    }

    throw new Error("B+tree sibling type mismatch");
  }

  private async buildInternal(children: readonly NodeId[]): Promise<InternalNode> {
    if (children.length == 0) throw new Error("B+tree internal node cannot be childless");

    const keys: EncodedKey[] = [];

    for (let i = 1; i < children.length; i++) keys.push(await this.minimum(children[i]!));

    return {
      type: "internal",
      keys,
      children: [...children],
    };
  }

  private async minimum(ref: NodeId): Promise<EncodedKey> {
    const seen = new Set<NodeId>();
    let cursor = ref;

    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      if (seen.has(cursor)) throw new Error("B+tree reference cycle detected");

      seen.add(cursor);

      const node = await this.nodes.read(cursor);

      if (node.type == "leaf") {
        if (!node.keys.length) throw new Error("Empty B+tree subtree");

        return node.keys[0]!;
      }

      cursor = node.children[0]!;
    }

    throw new Error("B+tree maximum depth exceeded");
  }

  private enter(ref: NodeId, depth: number, ancestors: Set<NodeId>): void {
    if (depth >= MAX_DEPTH) throw new Error("B+tree maximum depth exceeded");
    if (ancestors.has(ref)) throw new Error("B+tree reference cycle detected");

    ancestors.add(ref);
  }

  private async *traverse(
    ref: NodeId,
    lower: EncodedKey | null,
    upper: EncodedKey | null,
    depth: number,
    ancestors: Set<NodeId>,
  ): AsyncIterable<IndexEntry> {
    this.enter(ref, depth, ancestors);

    try {
      const node = await this.nodes.read(ref);

      if (node.type == "leaf") {
        const start = lower == null ? 0 : lowerBound(node.keys, lower);

        for (let i = start; i < node.keys.length; i++) {
          const key = node.keys[i]!;

          if (upper != null && key > upper) return;

          yield {
            key: decodeIndexKey(key),
            value: decodeIndexValue(node.values[i]!),
          };
        }

        return;
      }

      const start = lower == null ? 0 : upperBound(node.keys, lower);

      for (let i = start; i < node.children.length; i++) {
        if (upper != null && i > 0 && node.keys[i - 1]! > upper) return;

        yield* this.traverse(node.children[i]!, lower, upper, depth + 1, ancestors);
      }
    } finally {
      ancestors.delete(ref);
    }
  }
}
