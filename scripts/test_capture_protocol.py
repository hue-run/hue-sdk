"""Keep language packages on the same portable capture contract."""

from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class CaptureProtocolCopiesTests(unittest.TestCase):
    def test_both_languages_use_the_shared_canonical_hash_fixtures(self):
        fixtures = (ROOT / "packages/capture-protocol/fixtures.json").read_bytes()
        for language in ("typescript", "python"):
            with self.subTest(language=language):
                self.assertEqual(
                    (ROOT / f"packages/sdk-{language}/tests/fixtures/capture-v1.json").read_bytes(),
                    fixtures,
                )

    def test_installed_typescript_schema_is_the_public_wire_contract(self):
        self.assertEqual(
            (ROOT / "packages/sdk-typescript/src/capture/schema.json").read_bytes(),
            (ROOT / "packages/capture-protocol/schema.json").read_bytes(),
        )


if __name__ == "__main__":
    unittest.main()
