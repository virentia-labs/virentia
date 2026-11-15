import { posix } from "node:path";

/** The packages whose `store`, `event`, models and mutable stores receive SIDs. */
export const unitPackages: ReadonlySet<string> = new Set([
  "@virentia/core",
  "@virentia/core/models",
  "@virentia/mutable",
  "@virentia/ui",
]);

export type UnitKind = "store" | "event" | "model" | "mutable";

/** The kind of unit an export of `unitPackages` creates, if it takes a SID. */
export function unitKindOf(imported: string | undefined): UnitKind | undefined {
  return imported === "staticModel" || imported === "model"
    ? "model"
    : imported === "mutableStore"
      ? "mutable"
      : imported === "event"
        ? "event"
        : imported === "store" || imported === "reactive" || imported === "readonlyReactive"
          ? "store"
          : undefined;
}

/**
 * The SID prefix of a module: its path relative to the shared source root, so
 * that server and client builds from different checkouts agree.
 */
export function sourceIdentity(
  filename: string,
  root: string,
  cwd: string,
  namespace: string | undefined,
): string {
  let base = portablePath(root);
  if (!posix.isAbsolute(base) && !/^[a-z]:\//i.test(base)) {
    base = posix.resolve(portablePath(cwd), base);
  }
  const relative = posix.relative(base, portablePath(filename));
  return `v1:${encodeURIComponent(namespace ?? "")}:${encodeURIComponent(relative)}`;
}

function portablePath(filename: string): string {
  let normalized = filename.replace(/\\/g, "/");
  // Babel on POSIX may prefix a simulated Windows filename with cwd.
  const drive = /(?:^|\/)([a-z]:\/.*)$/i.exec(normalized);
  if (drive) normalized = drive[1][0].toLowerCase() + drive[1].slice(1);
  const unc = /(?:^|\/)(\\\\[^\\]+\\.*)$/.exec(filename);
  if (unc) normalized = unc[1].replace(/\\/g, "/");
  return posix.normalize(normalized);
}

export const sidErrors = {
  storeSpread:
    "[@virentia/core/compiler] Automatic store SIDs require explicit arguments (no argument spreads). " +
    "Use store(initial, skipToken, { sid: ... }) or disable automatic SIDs with sid: false.",
  storeOptions:
    "[@virentia/core/compiler] Automatic store SIDs require an object literal for the third argument. " +
    "Spread existing options into that object, or disable automatic SIDs with sid: false.",
  eventSpread:
    "[@virentia/core/compiler] Automatic event SIDs require explicit arguments (no argument spreads). " +
    "Use event({ sid: ... }) or disable automatic SIDs with sid: false.",
  eventMetadata:
    "[@virentia/core/compiler] Automatic event SIDs require an object literal for the second argument.",
  modelConfig:
    "Automatic model SIDs require a config object literal; use sid: false for dynamic configs",
  mutableOptions: "Automatic mutableStore SIDs require an options object literal",
};
