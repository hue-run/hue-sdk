"""Isolated validator process: no remote resources and no customer output in diagnostics."""

from __future__ import annotations

import json
import sys

from jsonschema import Draft202012Validator
from referencing import Registry
from referencing.exceptions import NoSuchResource


def refuse_resource(uri: str):
    raise NoSuchResource(ref=uri)


def main() -> None:
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    except (ImportError, OSError, ValueError):
        pass  # Wall-clock termination remains enforced by the parent on every platform.
    try:
        values = json.loads(sys.stdin.buffer.read(1024 * 1024 + 1))
        schema = values["schema"]
        Draft202012Validator.check_schema(schema)
        validator = Draft202012Validator(schema, registry=Registry(retrieve=refuse_resource))
        print(json.dumps({"match": validator.is_valid(values["output"])}))
    except Exception:
        print('{"error":true}')


if __name__ == "__main__":
    main()
