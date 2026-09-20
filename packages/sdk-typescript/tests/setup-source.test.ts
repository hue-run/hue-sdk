import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectExpressSource, inspectFlaskSource } from "../src/setup/source.js";
import { SetupBackendAdapter } from "../src/setup/backend.js";
import { detectSetupProject } from "../src/setup/detect.js";

const expressHead = 'import express from "express";\nconst app = express();\n';
const expressRoute = 'app.get("/", (request, response) => response.end("ok"));\n';
const expressListen = 'app.listen(Number(process.env.PORT), "127.0.0.1");\n';
const express = (listener = expressListen) => expressHead + expressRoute + listener;
const flaskHead = "import os\nfrom flask import Flask\napp = Flask(__name__)\n";
const flaskRoute = '@app.get("/")\ndef home():\n    return "ok"\n';
const flaskListen = 'app.run(host="127.0.0.1", port=int(os.environ["PORT"]))\n';
const flask = (listener = flaskListen) => flaskHead + flaskRoute + listener;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const invalidExpressListeners = [
  "app.listen(Number(process.env.PORT));\n",
  'app.listen(Number(process.env.PORT), "0.0.0.0");\n',
  'app.listen(Number(process.env.PORT), "localhost");\n',
  'app.listen(Number(process.env.PORT), "127.0.0.1", () => {});\n',
  'app.listen({port: Number(process.env.PORT), host: "127.0.0.1"});\n',
  'app.listen(...[Number(process.env.PORT), "127.0.0.1"]);\n',
  'app.listen(Number(process.env.PORT || 3000), "127.0.0.1");\n',
  'app.listen(Math.max(Number(process.env.PORT), 3000), "127.0.0.1");\n',
  'app.listen(Number(process.env.PORT) + 1, "127.0.0.1");\n',
  'app.listen(Number(process.env["PORT"]), "127.0.0.1");\n',
  'app.listen(parseInt(process.env.PORT), "127.0.0.1");\n',
  'const server = app.listen(Number(process.env.PORT), "127.0.0.1");\n',
  'function start() { app.listen(Number(process.env.PORT), "127.0.0.1"); }\nstart();\n',
  'if (true) app.listen(Number(process.env.PORT), "127.0.0.1");\n',
  'const start = app.listen; start(Number(process.env.PORT), "127.0.0.1");\n',
  expressListen + 'function extra() { app.listen(Number(process.env.PORT), "127.0.0.1"); }\n',
];

const invalidFlaskListeners = [
  'app.run("127.0.0.1", int(os.environ["PORT"]))\n',
  'app.run(host="0.0.0.0", port=int(os.environ["PORT"]))\n',
  'app.run(host="localhost", port=int(os.environ["PORT"]))\n',
  'app.run(port=int(os.environ["PORT"]), debug=True)\n',
  'app.run(port=int(os.environ["PORT"]), use_reloader=False)\n',
  'app.run(port=int(os.environ["PORT"]), ssl_context="adhoc")\n',
  'app.run(port=int(os.environ["PORT"]), processes=2)\n',
  'app.run(port=int(os.environ["PORT"]), request_handler=CustomHandler)\n',
  'app.run(port=int(os.environ["PORT"]), threaded=False)\n',
  'app.run(**{"port": int(os.environ["PORT"])})\n',
  'app.run(port=int(os.environ["PORT"]) + 1)\n',
  'app.run(port=int(os.environ.get("PORT", "3000")))\n',
  'app.run(port=int(os.environ["PORT"], 10))\n',
  'app.run(port=3000 if os.environ["PORT"] else 3001)\n',
  'server = app.run(port=int(os.environ["PORT"]))\n',
  'def start():\n    app.run(port=int(os.environ["PORT"]))\nstart()\n',
  'if os.environ.get("START"):\n    app.run(port=int(os.environ["PORT"]))\n',
  'if __name__ == "__main__":\n    app.run(port=int(os.environ["PORT"]))\nelse:\n    pass\n',
  'if __name__ == "__main__":\n    print("starting")\n    app.run(port=int(os.environ["PORT"]))\n',
  flaskListen + 'def extra():\n    app.run(port=int(os.environ["PORT"]))\n',
];

describe("bounded application listener syntax", () => {
  test("permits only the supported Express port expression and literal loopback listener", () => {
    for (const port of ["process.env.PORT", "Number(process.env.PORT)"])
      expect(inspectExpressSource(express(`app.listen(${port}, "127.0.0.1");\n`)).requestPath).toBe(
        "/",
      );
    for (const listener of invalidExpressListeners)
      expect(() => inspectExpressSource(express(listener))).toThrow("Unsupported");
    expect(() => inspectExpressSource(expressHead + expressListen + expressRoute)).toThrow(
      "Unsupported",
    );
  });

  test("refuses shadowed port conversion and request socket identity access", () => {
    for (const binding of [
      "const Number = (value) => 3000;\n",
      "const { Number } = custom;\n",
      "Number = custom;\n",
      "const process = custom;\n",
      'import { default as Number } from "node:fs";\n',
    ])
      expect(() => inspectExpressSource(binding + express())).toThrow();
    for (const access of [
      "request.socket.localPort",
      "request.connection.remoteAddress",
      'request["socket"].localPort',
      "request?.socket?.localAddress",
    ])
      expect(() =>
        inspectExpressSource(express().replace('response.end("ok")', `response.end(${access})`)),
      ).toThrow();
    for (const binding of ["const {socket} = request;", "const {connection: transport} = request;"])
      expect(() =>
        inspectExpressSource(
          express().replace('response.end("ok")', `{ ${binding} response.end("ok"); }`),
        ),
      ).toThrow();
  });

  test("permits one Flask run after the route, directly or in the exact main guard", () => {
    for (const listener of [
      flaskListen,
      'app.run(port=int(os.environ["PORT"]))\n',
      'if __name__ == "__main__":\n    ' + flaskListen,
    ])
      expect(inspectFlaskSource(flask(listener)).requestPath).toBe("/");
    for (const listener of invalidFlaskListeners)
      expect(() => inspectFlaskSource(flask(listener))).toThrow("unambiguous Flask source");
    expect(() => inspectFlaskSource(flaskHead + flaskListen + flaskRoute)).toThrow();
    for (const prefix of [
      "int = lambda value: 3000\n",
      "from custom import int\n",
      "import custom as os\n",
    ])
      expect(() => inspectFlaskSource(prefix + flask())).toThrow();
  });

  test("Python static compilation rejects invalid future/prologue semantics without execution", () => {
    for (const source of [
      flaskHead + "from __future__ import annotations\n" + flaskRoute + flaskListen,
      "return\n" + flask(),
      "yield 1\n" + flask(),
    ])
      expect(() => inspectFlaskSource(source)).toThrow("unambiguous Flask source");
    expect(
      inspectFlaskSource('("module documentation")\nfrom __future__ import annotations\n' + flask())
        .requestPath,
    ).toBe("/");
    for (const access of ['request.environ["werkzeug.socket"]', "request.socket.local_port"])
      expect(() =>
        inspectFlaskSource(flask().replace('return "ok"', `return str(${access})`)),
      ).toThrow();
  });
});

test("unsafe listener preflight makes no package, provisioning or project mutation", async () => {
  for (const language of ["typescript", "python"] as const) {
    const cases = language === "typescript" ? invalidExpressListeners : invalidFlaskListeners;
    for (const listener of cases) {
      const root = await mkdtemp(join(tmpdir(), "hue-listener-preflight-"));
      roots.push(root);
      const files =
        language === "typescript"
          ? {
              "package.json": JSON.stringify({
                type: "module",
                packageManager: "npm@11.0.0",
                scripts: { start: "node server.mjs" },
                dependencies: { express: "5.1.0" },
              }),
              "package-lock.json": "{}\n",
              "server.mjs": express(listener),
            }
          : {
              "pyproject.toml":
                '[project]\nname="listener-test"\nversion="0.1.0"\ndependencies=["flask==3.1.2"]\n',
              "uv.lock": "version = 1\n",
              "app.py": flask(listener),
            };
      for (const [path, contents] of Object.entries(files))
        await writeFile(join(root, path), contents!);
      let requests = 0;
      let commands = 0;
      const backend = new SetupBackendAdapter({
        projectRoot: root,
        origin: "https://example.invalid",
        fetch: (async () => {
          requests++;
          throw new Error("Unexpected preflight network request");
        }) as unknown as typeof fetch,
        commandRunner: async () => {
          commands++;
          throw new Error("Unexpected package-manager invocation");
        },
      });
      await expect(backend.preflight(await detectSetupProject(root))).rejects.toMatchObject({
        code: "ambiguous-entrypoint",
      });
      expect(requests).toBe(0);
      expect(commands).toBe(0);
      expect((await readdir(root)).sort()).toEqual(Object.keys(files).sort());
      for (const [path, contents] of Object.entries(files))
        expect(await readFile(join(root, path), "utf8")).toBe(contents!);
    }
  }
});
