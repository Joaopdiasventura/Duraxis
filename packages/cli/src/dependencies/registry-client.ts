import { record, stringMap } from "../init/project-detector.js";
export interface PublishedVersion {
  version: string;
  dependencies: Record<string, string>;
  peers: Record<string, string>;
  optionalPeers: Set<string>;
  node?: string;
}
export interface PackageMetadata {
  name: string;
  versions: PublishedVersion[];
  tags: Record<string, string>;
}
export class RegistryClient {
  private readonly cache = new Map<string, Promise<PackageMetadata>>();
  public constructor(
    private readonly registry = "https://registry.npmjs.org/",
    private readonly request: typeof fetch = fetch,
    private readonly signal?: AbortSignal,
  ) {
    const url = new URL(registry);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Registry must be an HTTP(S) URL without embedded credentials");
  }
  public get(name: string): Promise<PackageMetadata> {
    let value = this.cache.get(name);
    if (!value) {
      if (this.cache.size >= 64)
        throw new Error("Dependency metadata graph exceeds supported size");
      value = this.load(name);
      this.cache.set(name, value);
    }
    return value;
  }
  private async load(name: string): Promise<PackageMetadata> {
    if (!/^(?:@[a-z0-9-]+\/)?[a-z0-9._-]+$/.test(name)) throw new Error("Invalid package name");
    const signal = AbortSignal.any([
      AbortSignal.timeout(20_000),
      ...(this.signal ? [this.signal] : []),
    ]);
    try {
      const response = await this.request(
        new URL(
          encodeURIComponent(name),
          this.registry.endsWith("/") ? this.registry : this.registry + "/",
        ),
        { signal, headers: { accept: "application/json" }, redirect: "error" },
      );
      if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`);
      if (!response.body) throw new Error("Registry returned no metadata");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 16 * 1024 * 1024 || chunks.length >= 4096)
            throw new Error("Registry metadata exceeds limit");
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel();
      }
      let data: unknown;
      try {
        data = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
      } catch {
        throw new Error("Registry returned invalid JSON metadata");
      }
      if (!record(data) || !record(data.versions)) throw new Error("Invalid registry metadata");
      const versions: PublishedVersion[] = [];
      for (const [number, item] of Object.entries(data.versions)) {
        if (!record(item)) throw new Error("Invalid published version");
        const optionalPeers = new Set<string>();
        if (record(item.peerDependenciesMeta))
          for (const [peer, info] of Object.entries(item.peerDependenciesMeta))
            if (record(info) && info.optional === true) optionalPeers.add(peer);
        versions.push({
          version: number,
          dependencies: stringMap(item.dependencies),
          peers: stringMap(item.peerDependencies),
          optionalPeers,
          ...(record(item.engines) && typeof item.engines.node === "string"
            ? { node: item.engines.node }
            : {}),
        });
      }
      return { name, versions, tags: stringMap(data["dist-tags"]) };
    } catch (error) {
      if (signal.aborted) throw new Error(`Registry request timed out or cancelled for ${name}`);
      throw new Error(
        `Unable to resolve ${name}: ${error instanceof Error && !/https?:/.test(error.message) ? error.message : "registry request failed"}`,
      );
    }
  }
}
