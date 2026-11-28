import { RegistryClient } from "./registry-client.js";
import { compare, satisfies, version } from "./version-compatibility.js";
export async function resolveDependencies(
  names: readonly string[],
  existing: Record<string, string>,
  registry: RegistryClient,
  prerelease = false,
  node = process.versions.node,
  preserveExisting = true,
): Promise<Record<string, string>> {
  const constraints = new Map<string, Set<string>>(
    names.map((name) => [name, new Set<string>(name === "@types/node" ? ["24.x"] : [])]),
  );
  const selected = new Map<string, string>();
  for (let round = 0; round < 32; round++) {
    let changed = false;
    for (const [name, ranges] of constraints) {
      if (constraints.size > 48) throw new Error("Dependency graph exceeds supported size");
      const metadata = await registry.get(name);
      const candidates = metadata.versions
        .filter(
          (v) =>
            (prerelease || !version(v.version).prerelease) &&
            (!v.node || satisfies(node, v.node)) &&
            [...ranges].every((range) => satisfies(v.version, range)),
        )
        .sort((a, b) => compare(b.version, a.version));
      const candidate =
        (!prerelease && metadata.tags.latest
          ? candidates.find((candidate) => candidate.version === metadata.tags.latest)
          : undefined) ?? candidates[0];
      if (!candidate)
        throw new Error(
          `No compatible published version for ${name}; check Node.js and peer dependency constraints`,
        );
      if (selected.get(name) !== candidate.version) {
        selected.set(name, candidate.version);
        changed = true;
      }
      for (const [dependency, range] of Object.entries({
        ...Object.fromEntries(
          Object.entries(candidate.dependencies).filter(([n]) => n.startsWith("@duraxis/")),
        ),
        ...candidate.peers,
      })) {
        if (
          candidate.optionalPeers.has(dependency) &&
          !existing[dependency] &&
          !constraints.has(dependency)
        )
          continue;
        if (!constraints.has(dependency) && existing[dependency]) {
          // Preserve existing peers only if the entire declared range is not guessed compatible.
          const peerMetadata = await registry.get(dependency);
          const possible = peerMetadata.versions.filter(
            (v) => !version(v.version).prerelease && satisfies(v.version, existing[dependency]!),
          );
          if (!possible.length || !possible.every((v) => satisfies(v.version, range)))
            throw new Error(
              `Existing ${dependency} (${existing[dependency]}) is not provably compatible with ${range}; choose a compatible explicit version`,
            );
          continue;
        }
        let set = constraints.get(dependency);
        if (!set) {
          set = new Set();
          constraints.set(dependency, set);
          changed = true;
        }
        if (!set.has(range)) {
          set.add(range);
          changed = true;
        }
      }
    }
    if (!changed)
      return Object.fromEntries(
        [...selected].map(([name, target]) => [
          name,
          preserveExisting && existing[name] && satisfies(target, existing[name]!)
            ? existing[name]!
            : target,
        ]),
      );
  }
  throw new Error(
    "Dependency constraints did not converge; resolve package compatibility manually",
  );
}
