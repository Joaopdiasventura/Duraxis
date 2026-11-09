import type {
  EncodedKey,
  IndexEntry,
  InternalNode,
  LeafNode,
  NodeId,
  ScanOptions,
} from "./bptree-node.js";

import {
  compareKeys,
  decodeIndexKey,
  decodeIndexValue,
  encodeIndexKey,
  encodeIndexValue,
  lowerBound,
  upperBound,
} from "./bptree-codec.js";

import { BPlusTreeNodeStore } from "./bptree-node-store.js";

export interface BPlusTreeOptions {
  readonly maxKeys?: number;
}

interface Split {
  readonly separator: EncodedKey;
  readonly right: NodeId;
}

interface InsertResult {
  readonly root: NodeId;
  readonly split?: Split;
}

const MAX_DEPTH = 128;

export class BPlusTree {
  private readonly maxKeys: number;

  public constructor(
    private readonly nodes: BPlusTreeNodeStore,
    options: BPlusTreeOptions = {},
  ) {
    const maxKeys = options.maxKeys ?? 32;

    if (!Number.isSafeInteger(maxKeys) || maxKeys < 3 || maxKeys > 4096)
      throw new Error("Invalid B+tree maximum key count");

    this.maxKeys = maxKeys;
  }

  public async get(root: NodeId | null, key: Uint8Array): Promise<Uint8Array | null> {
    const target = encodeIndexKey(key);

    if (root == null) return null;

    let cursor = root;
    const visited = new Set<NodeId>();

    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      if (visited.has(cursor)) throw new Error("B+tree reference cycle detected");

      visited.add(cursor);

      const node = await this.nodes.read(cursor);

      if (node.type == "leaf") {
        const index = lowerBound(node.keys, target);

        if (node.keys[index] != target) return null;

        return decodeIndexValue(node.values[index]!);
      }

      const index = upperBound(node.keys, target);

      cursor = node.children[index]!;
    }

    throw new Error("B+tree maximum depth exceeded");
  }

  public async put(root: NodeId | null, key: Uint8Array, value: Uint8Array): Promise<NodeId> {
    const encodedKey = encodeIndexKey(key);
    const encodedValue = encodeIndexValue(value);

    if (root == null)
      return this.nodes.write({
        type: "leaf",
        keys: [encodedKey],
        values: [encodedValue],
      });

    const result = await this.insertRecursive(root, encodedKey, encodedValue, 0, new Set());

    if (!result.split) return result.root;

    return this.nodes.write({
      type: "internal",
      keys: [result.split.separator],
      children: [result.root, result.split.right],
    });
  }

  private async insertRecursive(
    ref: NodeId,
    key: EncodedKey,
    value: string,
    depth: number,
    ancestors: Set<NodeId>,
  ): Promise<InsertResult> {
    if (depth >= MAX_DEPTH) throw new Error("B+tree maximum depth exceeded");
    if (ancestors.has(ref)) throw new Error("B+tree reference cycle detected");

    ancestors.add(ref);

    try {
      const node = await this.nodes.read(ref);

      if (node.type == "leaf") return this.insertIntoLeaf(node, key, value);

      return this.insertIntoInternal(node, key, value, depth, ancestors);
    } finally {
      ancestors.delete(ref);
    }
  }

  private async insertIntoLeaf(
    node: LeafNode,
    key: EncodedKey,
    value: string,
  ): Promise<InsertResult> {
    const keys = [...node.keys];
    const values = [...node.values];
    const index = lowerBound(keys, key);

    if (keys[index] == key) {
      values[index] = value;
    } else {
      keys.splice(index, 0, key);
      values.splice(index, 0, value);
    }

    if (keys.length <= this.maxKeys)
      return {
        root: await this.nodes.write({
          type: "leaf",
          keys,
          values,
        }),
      };

    const midpoint = Math.ceil(keys.length / 2);

    const left: LeafNode = {
      type: "leaf",
      keys: keys.slice(0, midpoint),
      values: values.slice(0, midpoint),
    };

    const right: LeafNode = {
      type: "leaf",
      keys: keys.slice(midpoint),
      values: values.slice(midpoint),
    };

    const leftRef = await this.nodes.write(left);
    const rightRef = await this.nodes.write(right);

    return {
      root: leftRef,
      split: {
        separator: right.keys[0]!,
        right: rightRef,
      },
    };
  }

  private async insertIntoInternal(
    node: InternalNode,
    key: EncodedKey,
    value: string,
    depth: number,
    ancestors: Set<NodeId>,
  ): Promise<InsertResult> {
    const keys = [...node.keys];
    const children = [...node.children];

    const childIndex = upperBound(keys, key);

    const result = await this.insertRecursive(
      children[childIndex]!,
      key,
      value,
      depth + 1,
      ancestors,
    );

    children[childIndex] = result.root;

    if (result.split) {
      keys.splice(childIndex, 0, result.split.separator);
      children.splice(childIndex + 1, 0, result.split.right);
    }

    if (keys.length <= this.maxKeys)
      return {
        root: await this.nodes.write({
          type: "internal",
          keys,
          children,
        }),
      };

    const midpoint = Math.floor(keys.length / 2);

    const separator = keys[midpoint]!;

    const left: InternalNode = {
      type: "internal",
      keys: keys.slice(0, midpoint),
      children: children.slice(0, midpoint + 1),
    };

    const right: InternalNode = {
      type: "internal",
      keys: keys.slice(midpoint + 1),
      children: children.slice(midpoint + 1),
    };

    const leftRef = await this.nodes.write(left);
    const rightRef = await this.nodes.write(right);

    return {
      root: leftRef,
      split: {
        separator,
        right: rightRef,
      },
    };
  }

  public async *scan(root: NodeId | null, options: ScanOptions = {}): AsyncIterable<IndexEntry> {
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

    if (options.gt != undefined && options.gte != undefined)
      throw new Error("Use either gt or gte");

    if (options.lt != undefined && options.lte != undefined)
      throw new Error("Use either lt or lte");

    const limit = options.limit ?? Number.MAX_SAFE_INTEGER;

    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid scan limit");

    if (root == null || limit == 0) return;

    let emitted = 0;

    for await (const entry of this.traverse(root, lower, upper, 0, new Set())) {
      const encoded = encodeIndexKey(entry.key);

      if (lower != null) {
        const comparison = compareKeys(encoded, lower);
        if (comparison < 0 || (comparison == 0 && options.gt != undefined)) continue;
      }

      if (upper != null) {
        const comparison = compareKeys(encoded, upper);
        if (comparison > 0 || (comparison == 0 && options.lt != undefined)) break;
      }

      yield entry;

      emitted++;

      if (emitted >= limit) return;
    }
  }

  private async *traverse(
    ref: NodeId,
    lower: EncodedKey | null,
    upper: EncodedKey | null,
    depth: number,
    ancestors: Set<NodeId>,
  ): AsyncIterable<IndexEntry> {
    if (depth >= MAX_DEPTH) throw new Error("B+tree maximum depth exceeded");

    if (ancestors.has(ref)) throw new Error("B+tree reference cycle detected");

    ancestors.add(ref);

    try {
      const node = await this.nodes.read(ref);

      if (node.type == "leaf") {
        const start = lower == null ? 0 : lowerBound(node.keys, lower);

        for (let index = start; index < node.keys.length; index++) {
          const key = node.keys[index]!;

          if (upper != null && compareKeys(key, upper) > 0) return;

          yield {
            key: decodeIndexKey(key),
            value: decodeIndexValue(node.values[index]!),
          };
        }

        return;
      }

      const start = lower == null ? 0 : upperBound(node.keys, lower);

      for (let index = start; index < node.children.length; index++) {
        if (upper != null && index > 0 && compareKeys(node.keys[index - 1]!, upper) > 0) return;

        yield* this.traverse(node.children[index]!, lower, upper, depth + 1, ancestors);
      }
    } finally {
      ancestors.delete(ref);
    }
  }
}
