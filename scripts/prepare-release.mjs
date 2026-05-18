import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

function run(command, args) {
  console.log(`\n> ${command} ${args.join(" ")}`);

  const result = spawnSync(command, args, {
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function readPendingChangesets() {
  if (!existsSync(".changeset")) {
    return [];
  }

  return readdirSync(".changeset")
    .filter((file) => file.endsWith(".md") && file !== "README.md")
    .map((file) => `.changeset/${file}`);
}

const pendingChangesets = readPendingChangesets();

if (pendingChangesets.length === 0) {
  console.log("No pending changesets found. Starting Changesets prompt.");
  run("pnpm", ["changeset"]);
}

const releaseChangesets = readPendingChangesets();

if (releaseChangesets.length === 0) {
  console.error("No pending changesets were created. Release preparation stopped.");
  process.exit(1);
}

console.log("Preparing release from changesets:");

for (const changeset of releaseChangesets) {
  console.log(`- ${changeset}`);
}

run("pnpm", ["version-packages"]);
run("pnpm", ["install", "--frozen-lockfile"]);
run("pnpm", ["typecheck"]);
run("pnpm", ["test"]);
run("pnpm", ["build"]);

console.log("\nRelease is prepared. Commit the generated changes, push main, then run the Release workflow.");
