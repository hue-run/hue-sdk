"""Alias distribution for hue-run.

Importing this module only points at the real package. The SDK module remains ``hue_sdk``,
provided by the ``hue-run`` distribution that this alias depends on.
"""

import warnings

warnings.warn(
    "hue-sdk is an alias distribution; install hue-run and `import hue_sdk` directly.",
    DeprecationWarning,
    stacklevel=2,
)
