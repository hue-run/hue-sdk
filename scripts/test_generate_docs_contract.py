"""Tests for the deterministic public documentation contract."""

import importlib.util
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

SCRIPT = Path(__file__).with_name("generate-docs-contract.py")
spec = importlib.util.spec_from_file_location("generate_docs_contract", SCRIPT)
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)
ROOT = Path(__file__).resolve().parents[1]


class DocumentationContractTests(unittest.TestCase):
    def test_checked_in_contract_matches_canonical_sources(self):
        expected = generator.render_contract(generator.build_contract(ROOT))
        self.assertEqual((ROOT / "docs-contract.json").read_text(), expected)

    def test_contract_contains_only_public_package_surfaces(self):
        contract = generator.build_contract(ROOT)
        self.assertEqual(contract["schemaVersion"], 1)
        self.assertEqual(
            contract["packages"]["typescript"]["version"],
            json.loads((ROOT / "packages/sdk-typescript/package.json").read_text())["version"],
        )
        self.assertIn(
            "McpServerInfo",
            contract["packages"]["typescript"]["entrypoints"]["@hue-run/sdk"]["publicExports"],
        )
        self.assertEqual(contract["packages"]["python"]["version"], "0.2.2")
        self.assertIn(
            "createHue",
            contract["packages"]["typescript"]["entrypoints"]["@hue-run/sdk"]["publicExports"],
        )
        self.assertIn(
            "create_hue_safe",
            contract["packages"]["python"]["modules"]["hue_sdk"]["publicExports"],
        )
        self.assertIn(
            "runLocalAgent",
            contract["packages"]["typescript"]["entrypoints"]["@hue-run/sdk/evals"]["publicExports"],
        )
        self.assertEqual(contract["packages"]["typescript"]["bins"], {"hue": "./dist/setup/cli.js"})
        self.assertIn(
            "runSetup",
            contract["packages"]["typescript"]["entrypoints"]["@hue-run/sdk/setup"][
                "publicExports"
            ],
        )
        self.assertEqual(
            contract["packages"]["typescript"]["schemas"][
                "@hue-run/sdk/setup-events.schema.json"
            ]["contractVersion"],
            2,
        )
        for name in (
            "EnvironmentDefinitionV1",
            "EnvironmentDefinitionV2",
            "GmailProviderInstance",
            "PublishableEnvironmentDefinition",
        ):
            self.assertIn(
                name,
                contract["packages"]["typescript"]["entrypoints"]["@hue-run/sdk/environment"][
                    "publicExports"
                ],
            )
        self.assertNotIn("generatedAt", contract)

    def test_typescript_export_parser_handles_aliases_star_types_and_declarations(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "types.ts").write_text(
                'export type { JsonValue, Original as Alias } from "./shared.js";\n'
                "export interface One {}\nexport type Two = string;\n"
            )
            entry = root / "index.ts"
            entry.write_text(
                'export { value, type Original as Alias } from "./values.js";\n'
                'export type * from "./types.js";\n'
                "export function local() {}\n"
            )
            self.assertEqual(
                generator.typescript_exports(entry),
                ["Alias", "JsonValue", "One", "Two", "local", "value"],
            )

    def test_contract_includes_nested_named_type_reexports(self):
        contract = generator.build_contract(ROOT)
        for entrypoint in ("@hue-run/sdk/environment", "@hue-run/sdk/evals"):
            self.assertIn(
                "JsonValue",
                contract["packages"]["typescript"]["entrypoints"][entrypoint]["publicExports"],
            )

    def test_check_output_rejects_a_stale_contract(self):
        expected = generator.render_contract(generator.build_contract(ROOT))
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "contract.json"
            output.write_text(json.dumps({"schemaVersion": 0}) + "\n")
            with redirect_stdout(io.StringIO()):
                self.assertFalse(generator.check_output(output, expected))
            output.write_text(expected)
            with redirect_stdout(io.StringIO()):
                self.assertTrue(generator.check_output(output, expected))


if __name__ == "__main__":
    unittest.main()
