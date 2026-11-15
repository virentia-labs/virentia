// Validate sibling repositories against this exact, possibly unreleased Core.
// No Git operations, registry installs, global links or parallel test workers.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, lstatSync, unlinkSync,
  symlinkSync, writeFileSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = path.dirname(root);
const { values } = parseArgs({ options: {
  phase: { type: "string", default: "all" }, repo: { type: "string" }, out: { type: "string" },
} });
if (!["link", "build", "runtime", "types", "integration", "smoke", "all"].includes(values.phase))
  throw Error("Unknown --phase");
const names = ["virentia", "forms", "storage", "net", "router"];
if (values.repo && !names.includes(values.repo)) throw Error("Unknown --repo");
const json = file => JSON.parse(readFileSync(file, "utf8"));
const repositories = names.map(name => {
  const directory = name === "virentia" ? root : path.join(base, name);
  const packages = readdirSync(path.join(directory, "packages"), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(path.join(directory, "packages", entry.name, "package.json")))
    .map(entry => { const cwd = path.join(directory, "packages", entry.name);
      return { cwd, manifest: json(path.join(cwd, "package.json")) }; });
  return { name, directory, packages };
});
const targets = new Map(repositories.flatMap(repo => repo.packages.map(pkg => [pkg.manifest.name, pkg.cwd])));
const shared = new Map([
  ["react", realpathSync(path.join(root, "packages/react/node_modules/react"))],
  ["react-dom", realpathSync(path.join(root, "packages/react/node_modules/react-dom"))],
  ["vue", realpathSync(path.join(root, "packages/vue/node_modules/vue"))],
  ["effector", realpathSync(path.join(root, "packages/effector/node_modules/effector"))],
  ["history", realpathSync(path.join(base, "router/packages/router/node_modules/history"))],
]);
const allTargets = new Map([...targets, ...shared]);
let linked = 0;
function linkModules(directory, manifest) {
  const declared = new Set(Object.keys({ ...manifest?.dependencies, ...manifest?.devDependencies, ...manifest?.peerDependencies }));
  for (const [name, target] of allTargets) {
    const entry = path.join(directory, name);
    const stat = existsSync(entry) ? lstatSync(entry) : undefined;
    if (stat?.isSymbolicLink()) {
      if (realpathSync(entry) === realpathSync(target)) continue;
      unlinkSync(entry);
    } else if (stat || !declared.has(name)) continue;
    mkdirSync(path.dirname(entry), { recursive: true });
    symlinkSync(path.relative(path.dirname(entry), target), entry);
    linked++;
  }
}
for (const repo of repositories) {
  linkModules(path.join(repo.directory, "node_modules"), json(path.join(repo.directory, "package.json")));
  for (const pkg of repo.packages) linkModules(path.join(pkg.cwd, "node_modules"), pkg.manifest);
  // Existing peer links inside pnpm must also point to the shared framework:
  // two React/Effector/Vue copies would give a misleading compatibility result.
  const store = path.join(repo.directory, "node_modules/.pnpm");
  for (const entry of readdirSync(store, { withFileTypes: true }))
    if (entry.isDirectory()) linkModules(path.join(store, entry.name, "node_modules"));
}
const ecosystem = path.join(root, "ecosystem");
linkModules(path.join(ecosystem, "node_modules"), json(path.join(ecosystem, "package.json")));
const resolution = [];
for (const repo of repositories) for (const pkg of repo.packages) {
  for (const name of Object.keys({ ...pkg.manifest.dependencies, ...pkg.manifest.devDependencies, ...pkg.manifest.peerDependencies })) {
    if (!targets.has(name)) continue;
    const actual = realpathSync(path.join(pkg.cwd, "node_modules", name));
    const expected = realpathSync(targets.get(name));
    if (actual !== expected) throw Error(`Duplicate ${name} in ${pkg.manifest.name}: ${actual}`);
    resolution.push({ consumer: pkg.manifest.name, dependency: name, actual });
  }
}
console.log(`Local links ready: ${targets.size} packages; ${linked} links changed; ${resolution.length} package resolutions verified.`);
if (values.phase === "link") process.exit(0);
const output = path.resolve(values.out ?? path.join(tmpdir(), `virentia-ecosystem-${Date.now()}`));
mkdirSync(output, { recursive: true });
if (existsSync(path.join(output, "summary.json"))) throw Error("Choose a fresh --out directory");
const report = { startedAt: new Date().toISOString(), node: process.version, pid: process.pid,
  phase: values.phase, resolution, checks: [], complete: false, success: false };
const save = () => writeFileSync(path.join(output, "summary.json"), JSON.stringify(report, null, 2) + "\n");
let active, interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  interrupted = true;
  active?.kill(signal);
  process.exitCode = 1;
});
async function run(label, cwd, args) {
  if (interrupted) throw Error("Ecosystem check interrupted");
  const log = path.join(output, label + ".log");
  const entry = { label, cwd, args, log, startedAt: new Date().toISOString() };
  report.checks.push(entry);
  console.log(`Running ${label}`);
  const stream = createWriteStream(log, { flags: "wx" });
  const repository = repositories.find(repo => cwd === repo.directory || cwd.startsWith(repo.directory + path.sep));
  const env = { ...process.env, PATH: [path.join(repository.directory, "node_modules/.bin"),
    path.join(root, "node_modules/.bin"), path.dirname(process.execPath), process.env.PATH].join(path.delimiter) };
  delete env.NODE_OPTIONS;
  const child = active = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  entry.pid = child.pid; save();
  child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
  const timer = setTimeout(() => child.kill("SIGTERM"), 180000);
  entry.exitCode = await new Promise(resolve => {
    child.on("error", error => { entry.error = String(error); resolve(-1); });
    child.on("close", code => resolve(code ?? -1));
  });
  clearTimeout(timer); active = undefined;
  await new Promise(resolve => stream.end(resolve));
  entry.finishedAt = new Date().toISOString(); save();
  if (entry.exitCode !== 0) throw Error(`${label} failed; see ${log}`);
  console.log(`Passed ${label}`);
}
const selected = repositories.filter(repo => !values.repo || repo.name === values.repo);
const phases = values.phase === "all" ? ["build", "runtime", "types", "integration", "smoke"] : [values.phase];
try {
  for (const phase of phases) {
    if (phase === "smoke") {
      for (const format of ["esm", "cjs"])
        await run(`ecosystem-${format}-smoke`, ecosystem, [path.join(ecosystem, "smoke.mjs"), format]);
      continue;
    }
    if (phase === "integration") {
      await run("ecosystem-types", ecosystem, [path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", "tsconfig.json"]);
      await run("ecosystem-runtime", ecosystem, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--threads", "false"]);
      continue;
    }
    for (const repo of selected) {
      const order = repo.name === "virentia" ? ["core", "ui", "react", "vue", "mutable", "effector", "inspector"]
        : repo.name === "forms" ? ["forms", "forms-react", "forms-zod", "effector"]
        : repo.name === "router" ? ["paths", "router", "react", "react-native"] : ["core", "react", "vue"];
      for (const name of order) {
        const pkg = repo.packages.find(p => path.basename(p.cwd) === name);
        if (!pkg) continue;
        if (phase === "build") {
          await run(`${repo.name}-${name}-build`, pkg.cwd, [path.join(repo.directory, "node_modules/tsdown/dist/run.mjs")]);
          continue;
        }
        const vitest = path.join(repo.directory, "node_modules/vitest/vitest.mjs");
        const modern = Number(json(path.join(repo.directory, "node_modules/vitest/package.json")).version.split(".")[0]) >= 1;
        const serial = modern ? ["--maxWorkers=1", "--no-file-parallelism"] : ["--threads", "false"];
        if (phase === "runtime") await run(`${repo.name}-${name}-runtime`, pkg.cwd, [vitest, "run", ...serial]);
        else if (repo.name === "virentia" && name === "ui")
          await run("virentia-ui-types", pkg.cwd, [path.join(repo.directory, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", "tsconfig.vitest.json"]);
        else await run(`${repo.name}-${name}-types`, pkg.cwd, [vitest, ...(modern ? ["--typecheck.only", "--run"] : ["typecheck", "--run"]), ...serial, "--passWithNoTests"]);
      }
      if (phase === "types") await run(`${repo.name}-root-types`, repo.directory, [path.join(repo.directory, "node_modules/typescript/bin/tsc"), "--noEmit"]);
    }
  }
  report.success = true;
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1; }
finally { report.complete = true; report.finishedAt = new Date().toISOString(); save(); console.log(`Report: ${output}`); }
