export const MANIFEST_KEY = "__duraxis/v1/manifest";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", {
  fatal: true,
});

export interface Manifest {
  readonly format: 1;
  readonly transactionId: string;
  readonly entries: ReadonlyMap<string, string>;
}

export interface Snapshot {
  readonly manifest: Manifest;
  readonly storageVersion: string | null;
}

export function emptyManifest(): Manifest {
  return {
    format: 1,
    transactionId: "",
    entries: new Map(),
  };
}

export function encodeManifest(manifest: Manifest): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      format: 1,
      transactionId: manifest.transactionId,
      entries: Object.fromEntries(manifest.entries),
    }),
  );
}

export function decodeManifest(data: Uint8Array): Manifest {
  const parsed: unknown = JSON.parse(decoder.decode(data));

  if (
    typeof parsed != "object" ||
    parsed == null ||
    !("format" in parsed) ||
    parsed.format != 1 ||
    !("transactionId" in parsed) ||
    typeof parsed.transactionId != "string" ||
    !("entries" in parsed) ||
    typeof parsed.entries != "object" ||
    parsed.entries == null ||
    Array.isArray(parsed.entries)
  )
    throw new Error("Invalid Duraxis manifest");

  const entries = Object.entries(parsed.entries);

  for (const [key, value] of entries)
    if (!key || typeof value != "string" || !value) throw new Error("Invalid manifest entry");

  return {
    format: 1,
    transactionId: parsed.transactionId,
    entries: new Map(entries as [string, string][]),
  };
}
