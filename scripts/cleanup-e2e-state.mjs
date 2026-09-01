import { access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const e2eStateDirectory = path.join(
  tmpdir(),
  "lyrics-dictation-e2e-current",
);

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });

export const cleanupE2eState = async () => {
  try {
    await access(e2eStateDirectory);
  } catch {
    return;
  }
  if (process.platform === "darwin") await run("trash", [e2eStateDirectory]);
  else await rm(e2eStateDirectory, { recursive: true, force: true });
};

export default cleanupE2eState;
