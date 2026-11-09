import { createHash, timingSafeEqual } from "node:crypto";

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertDigest(bytes: Uint8Array, expected: string): void {
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error("Invalid digest");

  const actual = Buffer.from(sha256(bytes), "hex");

  if (!timingSafeEqual(actual, Buffer.from(expected, "hex")))
    throw new Error("Duraxis integrity check failed");
}
