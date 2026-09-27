#!/usr/bin/env node
import { resolve } from "node:path";
import { buildStart, serveStart } from "./node";

async function main(): Promise<void> {
  const command = process.argv[2];
  const flags = new Map<string, string>();
  for (let index = 3; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    const value = process.argv[index + 1];
    if (
      !flag ||
      !["--root", "--port", "--host"].includes(flag) ||
      !value ||
      value.startsWith("--")
    ) {
      throw new Error(
        "Usage: virentia-start <build|serve> [--root directory] [--port number] [--host address]",
      );
    }
    flags.set(flag, value);
  }
  const root = resolve(flags.get("--root") ?? process.cwd());
  if (command === "build") {
    await buildStart({ root });
    return;
  }
  if (command === "serve") {
    const port = flags.has("--port") ? Number(flags.get("--port")) : undefined;
    const server = await serveStart({ root, port, host: flags.get("--host") });
    const address = server.address();
    console.log(
      `[ui/start] Listening on ${typeof address === "object" && address ? `${address.address}:${address.port}` : address}`,
    );
    return;
  }
  throw new Error(
    "Usage: virentia-start <build|serve> [--root directory] [--port number] [--host address]",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
