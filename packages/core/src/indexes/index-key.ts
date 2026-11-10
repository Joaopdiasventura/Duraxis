import type { IndexOrder, IndexScalar } from "../catalog/collection-schema.js";

const MASK = 0xffffffffffffffffn;
const SIGN = 0x8000000000000000n;
const encoder = new TextEncoder();

export interface IndexKeyPart {
  readonly value: IndexScalar;
  readonly order?: IndexOrder;
}

export interface EncodedIndexBounds {
  readonly gt?: Uint8Array;
  readonly gte?: Uint8Array;
  readonly lt?: Uint8Array;
  readonly lte?: Uint8Array;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) if (a[i] != b[i]) return a[i]! < b[i]! ? -1 : 1;
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

function escapedUtf8(tag: number, value: string): Uint8Array {
  const bytes = encoder.encode(value);
  const result: number[] = [tag];
  for (const byte of bytes) byte == 0 ? result.push(0, 0xff) : result.push(byte);
  result.push(0, 0);
  return Uint8Array.from(result);
}

function orderedFloat(value: number): Uint8Array {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, Object.is(value, -0) ? 0 : value, false);
  const bits = view.getBigUint64(0, false);
  view.setBigUint64(0, (bits & SIGN) != 0n ? ~bits & MASK : bits ^ SIGN, false);
  return new Uint8Array(buffer);
}

function ascendingScalar(value: IndexScalar): Uint8Array {
  if (value === null) return Uint8Array.of(0x10);
  if (typeof value == "boolean") return Uint8Array.of(value ? 0x21 : 0x20);

  if (typeof value == "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid indexed number");
    return concatBytes(Uint8Array.of(0x30), orderedFloat(value));
  }

  if (value instanceof Date) {
    const time = value.getTime();

    if (!Number.isFinite(time)) throw new Error("Invalid indexed date");
    return concatBytes(Uint8Array.of(0x40), orderedFloat(time));
  }

  if (typeof value == "string") return escapedUtf8(0x50, value);
  throw new Error("Invalid indexed scalar");
}

function descending(bytes: Uint8Array): Uint8Array {
  const result = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) result[i] = 0xff ^ bytes[i]!;
  return result;
}

export function encodeScalar(value: IndexScalar, order: IndexOrder = "ASC"): Uint8Array {
  if (order != "ASC" && order != "DESC") throw new Error("Invalid index order");
  const encoded = ascendingScalar(value);
  return order == "ASC" ? encoded : descending(encoded);
}

export function encodeCompositeKey(parts: readonly IndexKeyPart[]): Uint8Array {
  if (!Array.isArray(parts) || parts.length == 0) throw new Error("Composite key has no parts");
  return concatBytes(...parts.map((part) => encodeScalar(part.value, part.order ?? "ASC")));
}

export function encodeIdentifier(id: string): Uint8Array {
  if (typeof id != "string" || id.length == 0) throw new Error("Invalid index record ID");
  return escapedUtf8(0x70, id);
}

export function encodeSecondaryKey(
  value: IndexScalar | readonly IndexScalar[],
  id?: string,
  orders?: readonly IndexOrder[],
): Uint8Array {
  const values = Array.isArray(value) ? value : [value as IndexScalar];
  if (values.length == 0) throw new Error("Secondary key has no values");
  if (orders != null && orders.length != values.length)
    throw new Error("Index order arity mismatch");
  const prefix = encodeCompositeKey(values.map((item, i) => ({ value: item, order: orders?.[i] })));
  return id === undefined ? prefix : concatBytes(prefix, encodeIdentifier(id));
}

export function prefixSuccessor(prefix: Uint8Array): Uint8Array | null {
  const result = new Uint8Array(prefix);

  for (let i = result.length - 1; i >= 0; i--)
    if (result[i]! < 0xff) {
      result[i]!++;
      return result.slice(0, i + 1);
    }

  return null;
}

export function prefixBounds(prefix: Uint8Array): EncodedIndexBounds {
  if (!(prefix instanceof Uint8Array) || prefix.length == 0) throw new Error("Invalid key prefix");
  const end = prefixSuccessor(prefix);
  return { gte: new Uint8Array(prefix), ...(end == null ? {} : { lt: end }) };
}

export function compositePrefixBounds(
  values: readonly IndexScalar[],
  orders?: readonly IndexOrder[],
): EncodedIndexBounds {
  return prefixBounds(encodeSecondaryKey(values, undefined, orders));
}

export function indexRangeBounds(options: {
  readonly gt?: readonly IndexScalar[];
  readonly gte?: readonly IndexScalar[];
  readonly lt?: readonly IndexScalar[];
  readonly lte?: readonly IndexScalar[];
  readonly orders?: readonly IndexOrder[];
}): EncodedIndexBounds {
  if (options.gt && options.gte) throw new Error("Use either gt or gte");
  if (options.lt && options.lte) throw new Error("Use either lt or lte");

  const encode = (values: readonly IndexScalar[]) =>
    encodeSecondaryKey(values, undefined, options.orders);

  return {
    ...(options.gt ? { gt: encode(options.gt) } : {}),
    ...(options.gte ? { gte: encode(options.gte) } : {}),
    ...(options.lt ? { lt: encode(options.lt) } : {}),
    ...(options.lte ? { lte: encode(options.lte) } : {}),
  };
}

export function compareIndexScalars(a: IndexScalar, b: IndexScalar): number {
  return compareBytes(encodeScalar(a), encodeScalar(b));
}
