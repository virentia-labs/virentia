import { readFile } from "node:fs/promises";

const artifacts = ["index.mjs", "index.cjs", "index.d.mts", "index.d.cts"];
const forbiddenModule = /["'](?:@virentia\/core\/models|@sinclair\/typebox(?:\/[^"']*)?)["']/;

for (const artifact of artifacts) {
  const source = await readFile(new URL(`../dist/${artifact}`, import.meta.url), "utf8");

  if (forbiddenModule.test(source)) {
    throw new Error(
      `${artifact} must not import @virentia/core/models or its optional TypeBox peer`,
    );
  }
}
