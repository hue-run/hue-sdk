<p align="center">
  <img alt="Hue" src="https://raw.githubusercontent.com/hue-run/hue-sdk/df0443f98c6096ff331fd0400715e4f3a1936607/.github/assets/hue-ascii-neutral.png" width="720">
</p>

# hue-run (npm alias)

`hue-run` is an alias of [`@hue-run/sdk`](https://www.npmjs.com/package/@hue-run/sdk), prepared so
that the name used by the Python distribution can resolve to the real Hue SDK on npm too. This alias
has not been published; use the scoped package for public installations. Every entry point re-exports it:

```js
import { createHue } from "hue-run"; // same as "@hue-run/sdk"
```

Install `@hue-run/sdk` directly in new code. The alias tracks the scoped package version and is
maintained in the [Hue SDK repository](https://github.com/hue-run/hue-sdk).

The prepared alias includes setup and the canonical scorer exports. To read and hash the
scorer's executable source, resolve `@hue-run/sdk/evals/conversion-outcome-core.mjs`; the alias file
only forwards exports and is not the executable whose digest is registered. The `hue` binary is
provided by the canonical dependency. Alias packaging tests do not imply alias publication.
