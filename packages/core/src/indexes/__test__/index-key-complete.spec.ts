import { describe, expect, it } from "vitest";
import {
  compareBytes,
  compareIndexScalars,
  encodeCompositeKey,
  encodeScalar,
  encodeSecondaryKey,
  prefixBounds,
} from "../index-key.js";
import type { IndexScalar } from "../../catalog/collection-schema.js";

const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");

describe("ordered index key encoding", () => {
  it("orders every supported scalar without collisions", () => {
    const values: IndexScalar[] = [
      null,
      false,
      true,
      -Number.MAX_VALUE,
      -1.5,
      -0,
      0,
      Number.MIN_VALUE,
      1.5,
      new Date("1900-01-01T00:00:00.000Z"),
      new Date("2026-11-10T00:00:00.000Z"),
      "",
      "a",
      "a\0b",
      "á",
      "😀",
    ];
    const encoded = values.map((value) => encodeScalar(value));
    expect(new Set(encoded.map(hex)).size).toBe(encoded.length - 1); // -0 and 0 are canonical equals
    for (let i = 1; i < values.length; i++)
      expect(compareBytes(encoded[i - 1]!, encoded[i]!)).toBeLessThanOrEqual(0);
  });

  it("reverses each descending component and preserves compound boundaries", () => {
    expect(compareBytes(encodeScalar(1, "DESC"), encodeScalar(2, "DESC"))).toBeGreaterThan(0);
    expect(hex(encodeCompositeKey([{ value: "a" }, { value: "bc" }]))).not.toBe(
      hex(encodeCompositeKey([{ value: "ab" }, { value: "c" }])),
    );
    expect(hex(encodeSecondaryKey(["same", 1], "a", ["ASC", "DESC"]))).not.toBe(
      hex(encodeSecondaryKey(["same", 1], "b", ["ASC", "DESC"])),
    );
  });

  it("builds exact prefix bounds", () => {
    const prefix = encodeSecondaryKey(["hardware", 10]);
    const bounds = prefixBounds(prefix);
    const inside = encodeSecondaryKey(["hardware", 10], "row-1");
    const outside = encodeSecondaryKey(["hardware", 11], "row-1");
    expect(compareBytes(inside, bounds.gte!)).toBeGreaterThanOrEqual(0);
    expect(compareBytes(inside, bounds.lt!)).toBeLessThan(0);
    expect(compareBytes(outside, bounds.lt!)).toBeGreaterThanOrEqual(0);
  });

  it("has reproducible ordering properties over random finite numbers", () => {
    let state = 0x12345678;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return (state / 0xffffffff - 0.5) * 1e12;
    };
    const values = Array.from({ length: 2_000 }, next).sort((a, b) => a - b);
    for (let i = 1; i < values.length; i++) {
      expect(
        compareBytes(encodeScalar(values[i - 1]!), encodeScalar(values[i]!)),
      ).toBeLessThanOrEqual(0);
      expect(compareIndexScalars(values[i - 1]!, values[i]!)).toBeLessThanOrEqual(0);
    }
  });

  it("rejects non-finite numbers and invalid dates", () => {
    expect(() => encodeScalar(Number.NaN)).toThrow("number");
    expect(() => encodeScalar(Number.POSITIVE_INFINITY)).toThrow("number");
    expect(() => encodeScalar(new Date(Number.NaN))).toThrow("date");
  });
});
