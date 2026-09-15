"""Validate the canonical protocol independently of either implementation."""
import json
from pathlib import Path
from jsonschema import Draft202012Validator

root = Path(__file__).parent
schema = json.loads((root / "schema.json").read_text())
fixtures = json.loads((root / "fixtures.json").read_text())
Draft202012Validator.check_schema(schema)
for case in fixtures["schemaCases"]:
    validator = Draft202012Validator({**schema, "$ref": "#/$defs/" + case["definition"]})
    assert validator.is_valid(case["value"]) == case["valid"], case
for name, width in (("externalTraceId", 32), ("externalSpanId", 16)):
    definition = "manifest" if width == 32 else "observation"
    validator = Draft202012Validator(schema["$defs"][definition]["properties"][name])
    assert not validator.is_valid("0" * width)
    assert validator.is_valid("0" * (width - 1) + "1")
print("Scenes schema admission fixtures passed")
