import type { IndexScalar } from "../catalog/collection-schema.js";

const MASK = 0xffffffffffffffffn;
const SIGN = 0x8000000000000000n;

const encoder = new TextEncoder();

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, p) => total + p.length, 0));

  let offset = 0;

  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

function escapedString(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  const result: number[] = [0x40];

  for (const byte of bytes)
    if (byte == 0) result.push(0, 0xff);
    else result.push(byte);

  result.push(0, 0);
  return Uint8Array.from(result);
}

export function encodeScalar(value: IndexScalar): Uint8Array {
  if (value == null) return Uint8Array.of(0x10);

  if (typeof value == "boolean") return Uint8Array.of(value ? 0x21 : 0x20);

  if (typeof value == "string") return escapedString(value);

  if (typeof value != "number" || !Number.isFinite(value))
    throw new Error("Invalid indexed scalar");

  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);

  view.setFloat64(0, Object.is(value, -0) ? 0 : value);

  const bits = view.getBigUint64(0, false);

  const ordered = (bits & SIGN) != 0n ? ~bits & MASK : bits ^ SIGN;

  view.setBigUint64(0, ordered, false);

  return concat(Uint8Array.of(0x30), new Uint8Array(buffer));
}

export function encodeSecondaryKey(value: IndexScalar, id?: string): Uint8Array {
  const scalar = encodeScalar(value);
  return id == undefined ? scalar : concat(scalar, escapedString(id));
}

export function prefixSuccessor(prefix: Uint8Array): Uint8Array | null {
  const result = new Uint8Array(prefix);

  for (let i = result.length - 1; i >= 0; i--)
    if (result[i]! < 255) {
      result[i]!++;
      return result.slice(0, i + 1);
    }

  return null;
}
