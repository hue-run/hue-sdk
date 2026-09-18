# hue-sdk (PyPI alias)

`hue-sdk` is an alias of [`hue-run`](https://pypi.org/project/hue-run/), published so that the name
matching the `hue_sdk` import module resolves to the real Hue SDK. Installing it installs `hue-run`:

```bash
pip install hue-sdk   # equivalent to: pip install hue-run
```

Install `hue-run` directly in new projects. The alias tracks the `hue-run` version and is maintained
in the [Hue SDK repository](https://github.com/hue-run/hue-sdk).
