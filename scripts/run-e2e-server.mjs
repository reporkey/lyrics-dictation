import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "vite";
import {
  cleanupE2eState,
  e2eStateDirectory as stateDirectory,
} from "./cleanup-e2e-state.mjs";

await cleanupE2eState();
await mkdir(stateDirectory, { recursive: true });

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
          ),
        );
    });
  });

try {
  await run(
    process.platform === "win32" ? "npx.cmd" : "npx",
    [
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--persist-to",
      stateDirectory,
    ],
    { env: { ...process.env, CI: "true" } },
  );

  process.env.LYRICS_E2E_STATE_DIR = stateDirectory;
  const server = await createServer({
    server: { host: "127.0.0.1", port: 41789, strictPort: true },
  });
  await server.listen();
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await server.close();
} finally {
  await cleanupE2eState();
}
