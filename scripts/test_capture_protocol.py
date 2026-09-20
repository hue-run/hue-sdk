"""Keep standalone capture assets consistent with the portable public contract."""

from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class CaptureProtocolCopiesTests(unittest.TestCase):
    def test_standalone_package_uses_canonical_hash_fixtures(self):
        self.assertEqual(
            (ROOT / "packages/sdk-typescript/tests/fixtures/capture-v1.json").read_bytes(),
            (ROOT / "packages/capture-protocol/fixtures.json").read_bytes(),
        )

    def test_installed_schema_is_the_public_wire_contract(self):
        self.assertEqual(
            (ROOT / "packages/sdk-typescript/src/capture/schema.json").read_bytes(),
            (ROOT / "packages/capture-protocol/schema.json").read_bytes(),
        )


if __name__ == "__main__":
    unittest.main()
