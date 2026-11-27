export const MINIMUM_NODE_VERSION = "24.15.0";

/** Reject unsupported runtimes before importing the CLI and its Node.js APIs. */
export function assertSupportedRuntime(version = process.versions.node) {
  const actual = version.split(".").map(Number);
  const minimum = MINIMUM_NODE_VERSION.split(".").map(Number);
  const difference = actual.findIndex((part, index) => part !== minimum[index]);
  const supported =
    /^\d+\.\d+\.\d+$/.test(version) &&
    (difference === -1 || actual[difference] > minimum[difference]);
  if (!supported)
    throw new Error(
      `Duraxis requires Node.js ${MINIMUM_NODE_VERSION} or newer.\nCurrent version: ${version}\nPlease upgrade your Node.js installation.`,
    );
}
