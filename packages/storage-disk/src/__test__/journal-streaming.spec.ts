import { describe, expect, it } from "vitest";
import {
  encodeJournalFrame,
  decodeJournal,
  replayJournal,
  MAX_JOURNAL_FRAME_BYTES,
} from "../disk-format.js";

function reader(bytes: Uint8Array, chunkSize: number) {
  let reads = 0;
  let largest = 0;
  return {
    stat: async () => ({ size: bytes.byteLength }),
    async read(target: Uint8Array, offset: number, length: number, position: number) {
      reads++;
      largest = Math.max(largest, length);
      const count = Math.min(chunkSize, length, Math.max(0, bytes.length - position));
      target.set(bytes.subarray(position, position + count), offset);
      return { bytesRead: count, buffer: target };
    },
    usage: () => ({ reads, largest }),
  };
}
describe("incremental journal replay", () => {
  it("matches reference decoding across every small read boundary with bounded frames", async () => {
    const bytes = Buffer.concat(
      Array.from({ length: 32 }, (_, i) =>
        encodeJournalFrame({ format: 1, sequence: i + 1, op: "delete", key: `record/${i}` }),
      ),
    );
    const expected = decodeJournal(bytes);
    for (let chunk = 1; chunk <= 9; chunk++) {
      const source = reader(bytes, chunk);
      const frames: unknown[] = [];
      const result = await replayJournal(source, bytes.length, (frame) => frames.push(frame));
      expect(frames).toEqual(expected.frames);
      expect(result.validBytes).toBe(bytes.length);
      expect(result.incompleteTail).toBe(false);
      expect(source.usage().largest).toBeLessThanOrEqual(MAX_JOURNAL_FRAME_BYTES);
    }
  });
  it("distinguishes incomplete headers and payload tails from invalid lengths and corruption", async () => {
    const first = encodeJournalFrame({ format: 1, sequence: 1, op: "delete", key: "first" });
    const second = encodeJournalFrame({ format: 1, sequence: 2, op: "delete", key: "second" });
    for (const length of [1, 3, 7, second.length - 1]) {
      const source = reader(Buffer.concat([first, second.subarray(0, length)]), 2);
      expect(await replayJournal(source, 1_000_000, () => {})).toEqual({
        validBytes: first.length,
        incompleteTail: true,
      });
    }
    const corrupt = new Uint8Array(first);
    corrupt[15] ^= 1;
    await expect(replayJournal(reader(corrupt, 3), 1_000_000, () => {})).rejects.toMatchObject({
      code: "CORRUPTION",
    });
    const invalid = new Uint8Array(4);
    new DataView(invalid.buffer).setUint32(0, MAX_JOURNAL_FRAME_BYTES + 1);
    await expect(replayJournal(reader(invalid, 1), 1_000_000, () => {})).rejects.toMatchObject({
      code: "CORRUPTION",
    });
  });
  it("checks total journal size before reading any payload", async () => {
    const source = reader(new Uint8Array(100), 1);
    await expect(replayJournal(source, 10, () => {})).rejects.toMatchObject({
      code: "RESOURCE_LIMIT",
    });
    expect(source.usage().reads).toBe(0);
  });
});
