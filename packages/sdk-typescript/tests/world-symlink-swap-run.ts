import { Writable } from "node:stream";
import { runWorldCommand } from "../src/cli/world.js";

// Runs one `hue world create` under tests/support/swap-before-read. The parent
// test watches the upload and the file the link points at.
const cwd = process.env.HUE_CWD;
if (!cwd) throw new Error("HUE_CWD is required");
let stdout = "";
let stderr = "";
const capture = (into: "out" | "err") =>
  new Writable({
    write(chunk, _encoding, callback) {
      if (into === "out") stdout += String(chunk);
      else stderr += String(chunk);
      callback();
    },
  });
const code = await runWorldCommand(process.argv.slice(2), {
  env: { PATH: process.env.PATH ?? "", HUE_API_KEY: process.env.HUE_API_KEY ?? "" },
  cwd,
  stdout: capture("out"),
  stderr: capture("err"),
  sleep: async () => {},
  onInterrupt: () => () => {},
});
process.stdout.write(`${JSON.stringify({ code, stdout, stderr })}\n`);
