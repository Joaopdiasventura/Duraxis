import { describe, expect, it } from "vitest";

import { MemoryStorageDriver } from "@duraxis/storage-memory";

import { StorageKeyManager } from "../../security/storage-key-manager.js";

import { BPlusTreeNodeStore } from "../bptree/bptree-node-store.js";

import { BPlusTree } from "../bptree/bptree.js";

import { compareKeys } from "../bptree/bptree-codec.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const encode = (value: string) => encoder.encode(value);

const decode = (value: Uint8Array | null) => (value == null ? null : decoder.decode(value));

function createTree(maxKeys = 4) {
  const storage = new MemoryStorageDriver();

  const keys = new StorageKeyManager();

  const nodes = new BPlusTreeNodeStore(storage, keys);

  const tree = new BPlusTree(nodes, {
    maxKeys,
  });

  return {
    storage,
    keys,
    nodes,
    tree,
  };
}

async function collect(tree: BPlusTree, root: string | null) {
  const result: Array<[string, string]> = [];

  for await (const entry of tree.scan(root))
    result.push([decoder.decode(entry.key), decoder.decode(entry.value)]);

  return result;
}

describe("Persistent B+tree", () => {
  it("returns null for an empty tree", async () => {
    const { tree } = createTree();

    expect(await tree.get(null, encode("missing"))).toBeNull();

    expect(await collect(tree, null)).toEqual([]);
  });

  it("inserts and retrieves one value", async () => {
    const { tree } = createTree();

    const root = await tree.put(null, encode("user:1"), encode("Joao"));

    expect(decode(await tree.get(root, encode("user:1")))).toBe("Joao");

    expect(await tree.get(root, encode("missing"))).toBeNull();
  });

  it("preserves old roots after insertion", async () => {
    const { tree } = createTree();

    const rootA = await tree.put(null, encode("a"), encode("1"));

    const rootB = await tree.put(rootA, encode("b"), encode("2"));

    expect(decode(await tree.get(rootA, encode("a")))).toBe("1");

    expect(await tree.get(rootA, encode("b"))).toBeNull();

    expect(decode(await tree.get(rootB, encode("b")))).toBe("2");
  });

  it("updates a value without modifying the prior root", async () => {
    const { tree } = createTree();

    const rootA = await tree.put(null, encode("key"), encode("old"));

    const rootB = await tree.put(rootA, encode("key"), encode("new"));

    expect(decode(await tree.get(rootA, encode("key")))).toBe("old");

    expect(decode(await tree.get(rootB, encode("key")))).toBe("new");
  });

  it("splits leaves and creates an internal root", async () => {
    const { tree, nodes } = createTree(3);

    let root: string | null = null;

    for (const key of ["a", "b", "c", "d"]) {
      root = await tree.put(root, encode(key), encode(key));
    }

    const node = await nodes.read(root!);

    expect(node.type).toBe("internal");

    expect(await collect(tree, root)).toEqual([
      ["a", "a"],
      ["b", "b"],
      ["c", "c"],
      ["d", "d"],
    ]);
  });

  it("splits internal nodes across multiple levels", async () => {
    const { tree, nodes } = createTree(3);

    let root: string | null = null;

    const expected: Array<[string, string]> = [];

    for (let index = 0; index < 100; index++) {
      const key = String(index).padStart(4, "0");
      const value = `value-${index}`;

      root = await tree.put(root, encode(key), encode(value));

      expected.push([key, value]);
    }

    const rootNode = await nodes.read(root!);

    expect(rootNode.type).toBe("internal");

    if (rootNode.type == "internal") {
      const child = await nodes.read(rootNode.children[0]!);

      expect(child.type).toBe("internal");
    }

    expect(await collect(tree, root)).toEqual(expected);
  });

  it("handles descending insertion order", async () => {
    const { tree } = createTree(3);

    let root: string | null = null;

    for (let index = 99; index >= 0; index--) {
      const key = String(index).padStart(3, "0");

      root = await tree.put(root, encode(key), encode(key));
    }

    const result = await collect(tree, root);

    expect(result).toHaveLength(100);

    expect(result.map(([key]) => key)).toEqual(
      Array.from({ length: 100 }, (_, index) => String(index).padStart(3, "0")),
    );
  });

  it("supports inclusive range scans", async () => {
    const { tree } = createTree(3);

    let root: string | null = null;

    for (const key of ["a", "b", "c", "d", "e"]) {
      root = await tree.put(root, encode(key), encode(key));
    }

    const entries: string[] = [];

    for await (const entry of tree.scan(root, {
      gte: encode("b"),
      lte: encode("d"),
    })) {
      entries.push(decoder.decode(entry.key));
    }

    expect(entries).toEqual(["b", "c", "d"]);
  });

  it("supports exclusive range scans", async () => {
    const { tree } = createTree(3);

    let root: string | null = null;

    for (const key of ["a", "b", "c", "d", "e"]) {
      root = await tree.put(root, encode(key), encode(key));
    }

    const entries: string[] = [];

    for await (const entry of tree.scan(root, {
      gt: encode("b"),
      lt: encode("e"),
    })) {
      entries.push(decoder.decode(entry.key));
    }

    expect(entries).toEqual(["c", "d"]);
  });

  it("supports scan limits", async () => {
    const { tree } = createTree(3);

    let root: string | null = null;

    for (let index = 0; index < 20; index++) {
      root = await tree.put(root, encode(String(index).padStart(2, "0")), encode(String(index)));
    }

    const entries: string[] = [];

    for await (const entry of tree.scan(root, {
      gte: encode("05"),
      limit: 3,
    })) {
      entries.push(decoder.decode(entry.key));
    }

    expect(entries).toEqual(["05", "06", "07"]);
  });

  it("preserves unsigned byte ordering", async () => {
    const { tree } = createTree(3);

    let root: string | null = null;

    for (const key of [255, 0, 128, 1]) {
      root = await tree.put(root, Uint8Array.of(key), Uint8Array.of(key));
    }

    const keys: number[] = [];

    for await (const entry of tree.scan(root)) {
      keys.push(entry.key[0]!);
    }

    expect(keys).toEqual([0, 1, 128, 255]);
  });

  it("rejects corrupted immutable nodes", async () => {
    const { tree, storage } = createTree();

    const root = await tree.put(null, encode("key"), encode("value"));

    const stored = await storage.get(root);

    expect(stored).not.toBeNull();

    const result = await storage.put(root, encode("corrupted"), {
      condition: {
        type: "if-version",
        version: stored!.version,
      },
    });

    expect(result.success).toBe(true);

    await expect(tree.get(root, encode("key"))).rejects.toThrow("integrity check failed");
  });

  it("matches a reference Map after many operations", async () => {
    const { tree } = createTree(4);

    const reference = new Map<string, string>();

    let root: string | null = null;

    // Deterministic pseudo-random sequence:
    // reproducible without an additional library.
    let seed = 123456789;

    function nextRandom() {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    }

    for (let index = 0; index < 500; index++) {
      const id = nextRandom() % 120;
      const key = String(id).padStart(4, "0");
      const value = `update-${index}`;

      root = await tree.put(root, encode(key), encode(value));

      reference.set(key, value);
    }

    const expected = [...reference.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    expect(await collect(tree, root)).toEqual(expected);

    for (const [key, value] of expected) {
      expect(decode(await tree.get(root, encode(key)))).toBe(value);
    }
  });

  it("keeps all leaves at the same depth", async () => {
    const { tree, nodes } = createTree(3);

    let root: string | null = null;

    for (let index = 0; index < 150; index++) {
      root = await tree.put(root, encode(String(index).padStart(4, "0")), encode(String(index)));
    }

    const depths = new Set<number>();

    async function visit(ref: string, depth: number): Promise<void> {
      const node = await nodes.read(ref);

      if (node.type == "leaf") {
        depths.add(depth);
        return;
      }

      expect(node.children.length).toBe(node.keys.length + 1);

      for (let i = 1; i < node.keys.length; i++)
        expect(compareKeys(node.keys[i - 1]!, node.keys[i]!)).toBeLessThan(0);

      for (const child of node.children) await visit(child, depth + 1);
    }

    await visit(root!, 0);

    expect(depths.size).toBe(1);
  });

  it("rejects invalid tree configuration", () => {
    const { nodes } = createTree();

    expect(() => new BPlusTree(nodes, { maxKeys: 1 })).toThrow("maximum key count");
  });

  it("rejects empty keys", async () => {
    const { tree } = createTree();

    await expect(tree.put(null, new Uint8Array(), encode("value"))).rejects.toThrow(
      "Invalid B+tree key",
    );
  });

  it("rejects conflicting scan bounds", async () => {
    const { tree } = createTree();

    const root = await tree.put(null, encode("key"), encode("value"));

    const consume = async () => {
      for await (const _entry of tree.scan(root, {
        gt: encode("a"),
        gte: encode("b"),
      })) {
      }
    };

    await expect(consume()).rejects.toThrow("Use either gt or gte");
  });
});
