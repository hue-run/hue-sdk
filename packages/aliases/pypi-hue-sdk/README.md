<p align="center">
  <img alt="Hue" src="https://raw.githubusercontent.com/hue-run/hue-sdk/df0443f98c6096ff331fd0400715e4f3a1936607/.github/assets/hue-ascii-neutral.png" width="720">
</p>

# hue-sdk (PyPI alias)

`hue-sdk` is an alias of [`hue-run`](https://pypi.org/project/hue-run/), prepared so that the name
matching the `hue_sdk` import module can resolve to the real Hue SDK. It has not been published to
PyPI, so `pip install hue-sdk` does not install Hue's SDK. Install the real package:

```bash
pip install hue-run
```

Install `hue-run` directly in new projects. The alias tracks the `hue-run` version and is maintained
in the [Hue SDK repository](https://github.com/hue-run/hue-sdk).
