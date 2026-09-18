<p align="center">
  <img alt="Hue" src="https://raw.githubusercontent.com/hue-run/hue-sdk/df0443f98c6096ff331fd0400715e4f3a1936607/.github/assets/hue-ascii-neutral.png" width="720">
</p>

# hue-run (npm alias)

`hue-run` is an alias of [`@hue-run/sdk`](https://www.npmjs.com/package/@hue-run/sdk), published so
that the name used by the Python distribution resolves to the real Hue SDK on npm too. Every entry
point re-exports the scoped package:

```js
import { createHue } from "hue-run"; // same as "@hue-run/sdk"
```

Install `@hue-run/sdk` directly in new code. The alias tracks the scoped package version and is
maintained in the [Hue SDK repository](https://github.com/hue-run/hue-sdk).
