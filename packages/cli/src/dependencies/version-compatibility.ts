export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
}
export function version(value: string): Version {
  const m = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!m) throw new Error("Unsupported version format in package metadata");
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? "" };
}
export function compare(a: string, b: string): number {
  const x = version(a),
    y = version(b);
  return (
    x.major - y.major ||
    x.minor - y.minor ||
    x.patch - y.patch ||
    (x.prerelease === y.prerelease
      ? 0
      : !x.prerelease
        ? 1
        : !y.prerelease
          ? -1
          : x.prerelease.localeCompare(y.prerelease, "en", { numeric: true }))
  );
}
export function satisfies(actual: string, range: string): boolean {
  version(actual);
  return range
    .trim()
    .replace(/([><=~^])\s+/g, "$1")
    .split(/\s*\|\|\s*/)
    .map((branch) => {
      if (!branch) throw new Error("Empty version range");
      return branch
        .split(/\s+/)
        .map((part) => {
          if (part === "*" || part === "latest") return true;
          const m =
            /^(\^|~|>=|<=|>|<|=)?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?$/.exec(
              part,
            );
          if (!m)
            throw new Error(
              "Unsupported version range syntax. Use exact, caret, tilde, wildcard or comparator ranges.",
            );
          const op = m[1] ?? "";
          const major = Number(m[2]);
          const minor = /^\d+$/.test(m[3] ?? "") ? Number(m[3]) : 0;
          const patch = /^\d+$/.test(m[4] ?? "") ? Number(m[4]) : 0;
          const base = `${major}.${minor}.${patch}${m[5] ? `-${m[5]}` : ""}`;
          const delta = compare(actual, base);
          const partialUpper =
            m[3] === undefined || /^(x|\*)$/.test(m[3])
              ? `${major + 1}.0.0`
              : m[4] === undefined || /^(x|\*)$/.test(m[4])
                ? `${major}.${minor + 1}.0`
                : undefined;
          if (op === ">" && partialUpper) return compare(actual, partialUpper) >= 0;
          if (op === "<=" && partialUpper) return compare(actual, partialUpper) < 0;
          if (op === ">=") return delta >= 0;
          if (op === ">") return delta > 0;
          if (op === "<=") return delta <= 0;
          if (op === "<") return delta < 0;
          if (op === "=")
            return delta >= 0 && (partialUpper ? compare(actual, partialUpper) < 0 : delta === 0);
          let upper: string | undefined;
          if (op === "^")
            upper =
              m[3] === undefined || /^(x|\*)$/.test(m[3])
                ? `${major + 1}.0.0`
                : major
                  ? `${major + 1}.0.0`
                  : minor || m[4] === undefined || /^(x|\*)$/.test(m[4])
                    ? `0.${minor + 1}.0`
                    : `0.0.${patch + 1}`;
          else if (op === "~")
            upper =
              m[3] === undefined || /^(x|\*)$/.test(m[3])
                ? `${major + 1}.0.0`
                : `${major}.${minor + 1}.0`;
          else if (m[3] === undefined || /^(x|\*)$/.test(m[3])) upper = `${major + 1}.0.0`;
          else if (m[4] === undefined || /^(x|\*)$/.test(m[4])) upper = `${major}.${minor + 1}.0`;
          return delta >= 0 && (upper ? compare(actual, upper) < 0 : delta === 0);
        })
        .every(Boolean);
    })
    .some(Boolean);
}
