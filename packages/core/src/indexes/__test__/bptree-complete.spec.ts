import { describe, expect, it } from "vitest";

import { MemoryStorageDriver } from "@duraxis/storage-memory";

import { StorageKeyManager } from "../../security/storage-key-manager.js";

import { BPlusTree } from "../bptree/bptree.js";

import { BPlusTreeNodeStore } from "../bptree/bptree-node-store.js";

import { BPlusTreeValidator } from "../bptree/bptree-validator.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const enc = (s: string) => encoder.encode(s);

const dec = (b: Uint8Array | null) => (b === null ? null : decoder.decode(b));

const k = (i: number) => enc(i.toString().padStart(4, "0"));

function fixture(maxKeys = 4, maxNodeBytes = 2048) {
  const storage = new MemoryStorageDriver();

  const nodes = new BPlusTreeNodeStore(storage, new StorageKeyManager());

  const options = {
    maxKeys,
    maxNodeBytes,
  };

  return {
    storage,
    nodes,
    tree: new BPlusTree(nodes, options),
    validator: new BPlusTreeValidator(nodes, maxKeys, maxNodeBytes),
  };
}

async function all(tree: BPlusTree, root: string | null) {
  const data: Array<[string, string]> = [];

  for await (const row of tree.scan(root)) {
    data.push([dec(row.key)!, dec(row.value)!]);
  }

  return data;
}

describe("B+tree complete", () => {
  it("removes missing keys without changing the root", async () => {
    const { tree, validator } = fixture();

    expect(await tree.delete(null, enc("absent"))).toBeNull();

    const root = await tree.put(null, enc("present"), enc("value"));

    expect(await tree.delete(root, enc("absent"))).toBe(root);

    expect((await validator.validate(root)).valid).toBe(true);
  });

  it("removes the last key and preserves the previous root", async () => {
    const { tree } = fixture();

    const old = await tree.put(null, enc("only"), enc("v"));

    expect(await tree.delete(old, enc("only"))).toBeNull();

    expect(dec(await tree.get(old, enc("only")))).toBe("v");
  });

  it("rebalances leaves and internal nodes and reduces the root", async () => {
    const { tree, validator } = fixture(3);

    let root: string | null = null;

    for (let i = 0; i < 120; i++) {
      root = await tree.put(root, k(i), k(i));
    }

    const old = root;

    for (let i = 0; i < 120; i++) {
      root = await tree.delete(root, k(i));

      const report = await validator.validate(root);

      expect(report.errors).toEqual([]);

      expect(report.entryCount).toBe(119 - i);
    }

    expect(root).toBeNull();

    expect(dec(await tree.get(old, k(119)))).toBe("0119");
  });

  it("supports COW batching without persisting intermediate roots", async () => {
    const { tree, validator, storage, nodes } = fixture(4);

    let root = await tree.put(null, enc("old"), enc("old value"));

    const previous = root;

    const before = (await storage.list(nodes.nodePrefix)).length;

    const ops = Array.from({ length: 200 }, (_, i) => ({
      type: "put" as const,
      key: k(i),
      value: enc(`value-${i}`),
    }));

    root = (await tree.batch(root, ops))!;

    const after = (await storage.list(nodes.nodePrefix)).length;

    const report = await validator.validate(root);

    expect(after - before).toBeLessThanOrEqual(report.nodeCount);

    expect(after - before).toBeGreaterThan(0);

    expect(dec(await tree.get(previous, enc("old")))).toBe("old value");

    expect(await tree.get(previous, k(199))).toBeNull();

    expect(report.valid).toBe(true);
  });

  it("does not persist changes when a batch fails during preparation", async () => {
    const { tree, storage, nodes } = fixture();

    const root = await tree.put(null, enc("a"), enc("original"));

    const before = (await storage.list(nodes.nodePrefix)).length;

    await expect(
      tree.batch(root, [
        {
          type: "put",
          key: enc("b"),
          value: enc("candidate"),
        },
        {
          type: "put",
          key: new Uint8Array(),
          value: enc("invalid"),
        },
      ]),
    ).rejects.toThrow("Invalid B+tree key");

    expect((await storage.list(nodes.nodePrefix)).length).toBe(before);

    expect(dec(await tree.get(root, enc("a")))).toBe("original");
  });

  it("matches Map after deterministic random insertions and deletions", async () => {
    const { tree, validator } = fixture(5);

    const model = new Map<string, string>();

    let root: string | null = null;
    let seed = 12345;

    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);

    for (let i = 0; i < 600; i++) {
      const key = String(random() % 90).padStart(4, "0");

      if (random() % 4 === 0) {
        root = await tree.delete(root, enc(key));

        model.delete(key);
      } else {
        root = await tree.put(root, enc(key), enc(`v${i}`));

        model.set(key, `v${i}`);
      }

      if (i % 20 === 0) {
        const report = await validator.validate(root);

        expect(report.errors).toEqual([]);

        expect(await all(tree, root)).toEqual([...model].sort(([a], [b]) => a.localeCompare(b)));
      }
    }
  });

  it("splits based on bytes rather than only key count", async () => {
    const { tree, validator } = fixture(100, 2048);

    let root: string | null = null;

    for (let i = 0; i < 70; i++) {
      root = await tree.put(root, k(i), enc("x".repeat(300)));
    }

    const report = await validator.validate(root);

    expect(report.valid).toBe(true);

    expect(report.leafCount).toBeGreaterThan(1);

    expect(report.entryCount).toBe(70);
  });

  it("handles inclusive and exclusive range scans after deletions", async () => {
    const { tree } = fixture(3);

    let root: string | null = null;

    for (let i = 0; i < 20; i++) {
      root = await tree.put(root, k(i), k(i));
    }

    root = await tree.delete(root, k(11));

    const found: string[] = [];

    for await (const row of tree.scan(root, {
      gt: k(8),
      lte: k(13),
      limit: 4,
    })) {
      found.push(dec(row.key)!);
    }

    expect(found).toEqual(["0009", "0010", "0012", "0013"]);
  });

  it("rejects foreign roots and corrupted nodes", async () => {
    const first = fixture();
    const second = fixture();

    const root = await first.tree.put(null, enc("key"), enc("value"));

    await expect(second.tree.get(root, enc("key"))).rejects.toThrow("Missing B+tree node");

    const stored = (await first.storage.get(root))!;

    await first.storage.put(root, enc("corrupt"), {
      condition: {
        type: "if-version",
        version: stored.version,
      },
    });

    expect((await first.validator.validate(root)).valid).toBe(false);
  });
});
