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

- **Inventory** (0.4 s). `(cd packages/sdk-typescript && bun run build && npm pack --dry-run --json --ignore-scripts) > $V/pack.json && python3 -c 'import json,sys;[print(f["path"]) for f in json.load(open(sys.argv[1]))[0]["files"]]' $V/pack.json | sort > $V/files.txt && wc -l < $V/files.txt`. Expected: exit 0 and the file count (142 at 0.16.0). When you add or remove files, run the same command on `main` into another file and paste the `diff` of the two lists.
- **Installed consumer** (about 2 s once packed). Pack, install into a scratch project and import the changed entry point:

  ```sh
  mkdir -p $V/consumer
  (cd packages/sdk-typescript && npm pack --ignore-scripts --pack-destination $V)
  (cd $V/consumer && npm init -y >/dev/null && npm install --no-audit --no-fund ../hue-run-sdk-*.tgz &&
    node --input-type=module -e 'const m = await import("@hue-run/sdk"); console.log(typeof m.createHue)')
  ```

  Expected: `function`. Replace the import with the subpath or export you changed.
- **Full verifier** (about 6.5 min, CI also runs it). `env -u HUE_API_KEY node packages/sdk-typescript/scripts/verify-package.mjs`. Expected: ends with `{"tarball":...,"consumer":...,"chatbot":...}` and exit 0. Run it locally only when the change affects the verifier itself or installed setup.

## Gotchas

- `npm pack` without `--ignore-scripts` is fine too, but build first: the tarball takes whatever is in `dist/`.
- A `HUE_API_KEY` in the shell fails the full verifier's `express-npm installed setup succeeds` assertion with `configuration_conflict`.
- The verifier's own temp directory is printed in its final JSON; it is not cleaned up automatically.
