#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const manifest = fileURLToPath(import.meta.resolve("@hue-run/sdk/package.json"));
await import(pathToFileURL(join(dirname(manifest), "dist", "setup", "cli.js")).href);
