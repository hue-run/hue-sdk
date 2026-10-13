# npm tarball

`@hue-run/sdk` is packed from `packages/sdk-typescript` into `hue-run-sdk-<version>.tgz`. Consumers import `@hue-run/sdk`, its subpaths (`/evals`, `/ai-sdk`, ...) and run the `hue` binary.

## Sub-features

- `npm-inventory` ships exactly the intended `dist/` files, docs and license.
- `npm-exports` resolves every `exports` entry under ESM, `require(esm)` and TypeScript.
- `npm-consumer` installs the tarball into a fresh Node or Bun project and runs it.

## How to get to it (user POV)

- `npm install @hue-run/sdk` or `npx -y @hue-run/sdk <command>`.

## Driving it with npm pack and node

Preconditions:

- `bun install --frozen-lockfile` done in `packages/sdk-typescript`.

- **Inventory** (0.4 s). `(cd packages/sdk-typescript && bun run build && npm pack --dry-run --json --ignore-scripts) > "$V"/pack.json && python3 -c 'import json,sys;[print(f["path"]) for f in json.load(open(sys.argv[1]))[0]["files"]]' "$V"/pack.json | sort > "$V"/files.txt && wc -l < "$V"/files.txt`. Expected: exit 0 and the file count (142 when this was written). When you add or remove files, run the same command on `main` into another file and paste the `diff` of the two lists.
- **Installed consumer** (about 2 s once packed). Pack, install into a scratch project and import the changed entry point:

  ```sh
  mkdir -p "$V"/consumer
  (cd packages/sdk-typescript && npm pack --ignore-scripts --pack-destination "$V")
  (cd "$V"/consumer && npm init -y >/dev/null && npm install --no-audit --no-fund ../hue-run-sdk-*.tgz &&
    node --input-type=module -e 'const m = await import("@hue-run/sdk"); console.log(typeof m.createHue)')
  ```

  Expected: `function`. Replace the import with the subpath or export you changed.
- **Full verifier** (about 6.5 min, CI also runs it). `env -u HUE_API_KEY node packages/sdk-typescript/scripts/verify-package.mjs`. Expected: ends with `{"tarball":...,"consumer":...,"chatbot":...}` and exit 0. Run it locally only when the change affects the verifier itself or installed setup.

## Gotchas

- `npm pack` without `--ignore-scripts` is fine too, but build first: the tarball takes whatever is in `dist/`.
- A `HUE_API_KEY` in the shell fails the full verifier's `express-npm installed setup succeeds` assertion with `configuration_conflict`.
- The verifier's own temp directory is printed in its final JSON; it is not cleaned up automatically.

## Media release contract

For TypeScript 0.18.2, compare `package.json`, `src/version.ts`, the packed package metadata and `docs-contract.json`. Run `python3 scripts/check-doc-versions.py` and `python3 scripts/generate-docs-contract.py --check` from the repository root. Confirm the frozen lock retains every resolved dependency version.

From an installed tarball, send binary media and text over 64 KiB to a loopback blob receiver. Check decoded bytes, the binary part's digest and size, and the text prefix and content-field entry. Exercise `recordFile` with upload omitted and enabled, a Unicode name, an upload failure, content capture disabled and setup credentials. Supplied helper data is limited to 25 MiB; whole string attributes retain their separate 1,000,000,000-byte limit. Inspect the same-span `event:hue.file:<sha256>` entry and the unchanged `hue.file` event. Place an `Attachment` in a `withSpan` input and in a `recordMessages` body next to an inline image, and check that each file is reserved once, the span lists `input.value#<pointer>` and the log record lists `body#<pointer>` entries in its own `hue.blobs`, under the span's trace. The shared corpus must remain byte-identical to the Python copy; fixtures are development inputs and must not enter the npm tarball.
