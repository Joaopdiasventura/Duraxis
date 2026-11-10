import { describe, expect, it } from "vitest";
import { MemoryStorageDriver } from "@duraxis/storage-memory";
import { StorageKeyManager } from "../../security/storage-key-manager.js";
import { BPlusTreeNodeStore } from "../bptree/bptree-node-store.js";
import { BPlusTree } from "../bptree/bptree.js";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

describe("B+tree incremental scan API", () => {
  it("scans ranges in both directions with inclusive/exclusive bounds", async () => {
    const tree = new BPlusTree(
      new BPlusTreeNodeStore(new MemoryStorageDriver(), new StorageKeyManager()),
      { maxKeys: 3 },
    );
    let root: string | null = null;
    for (const key of ["a", "b", "c", "d", "e", "f"])
      root = await tree.put(root, encode(key), encode(key));
    const collect = async (direction: "ASC" | "DESC") => {
      const result: string[] = [];
      for await (const entry of tree.scan(root, { gt: encode("b"), lte: encode("e"), direction }))
        result.push(decode(entry.key));
      return result;
    };
    expect(await collect("ASC")).toEqual(["c", "d", "e"]);
    expect(await collect("DESC")).toEqual(["e", "d", "c"]);
  });

  it("supports limits, cancellation and metrics without eager reads", async () => {
    const tree = new BPlusTree(
      new BPlusTreeNodeStore(new MemoryStorageDriver(), new StorageKeyManager()),
      { maxKeys: 3 },
    );
    let root: string | null = null;
    for (let i = 0; i < 20; i++)
      root = await tree.put(root, encode(String(i).padStart(2, "0")), encode(String(i)));
    const metrics = { nodesVisited: 0, entriesExamined: 0 };
    const controller = new AbortController();
    const iterator = tree
      .scan(root, { limit: 3, metrics, signal: controller.signal })
      [Symbol.asyncIterator]();
    expect(decode((await iterator.next()).value!.key)).toBe("00");
    controller.abort(new Error("stop"));
    await expect(iterator.next()).rejects.toThrow("stop");
    expect(metrics.nodesVisited).toBeGreaterThan(0);
    expect(metrics.entriesExamined).toBe(1);
  });

  it("handles empty and nonexistent ranges", async () => {
    const tree = new BPlusTree(
      new BPlusTreeNodeStore(new MemoryStorageDriver(), new StorageKeyManager()),
    );
    const result: string[] = [];
    for await (const entry of tree.scan(null, { direction: "DESC" }))
      result.push(decode(entry.key));
    expect(result).toEqual([]);
    const root = await tree.put(null, encode("a"), encode("a"));
    for await (const entry of tree.scan(root, { gt: encode("z") })) result.push(decode(entry.key));
    expect(result).toEqual([]);
  });
});
