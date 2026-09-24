from __future__ import annotations

import json
import sys

from hue_sdk._tool_definitions import scrub_tool_credentials, with_tool_catalog_summary


def test_scrubs_generic_credentials_and_url_userinfo_query_without_parameter_names():
    input_value = {
        "type": "mcp",
        "server_url": (
            "https://synthetic-user:synthetic-password@mcp.example.test/gmail"
            "?token=synthetic-query&region=synthetic-region"
        ),
        "token": "synthetic-token",
        "api_token": "synthetic-api-token",
        "bearer_token": "synthetic-bearer-token",
        "refresh_token": "synthetic-refresh-token",
        "client_secret": "synthetic-client-secret",
        "api_secret": "synthetic-api-secret",
        "password": "synthetic-password",
        "database_password": "synthetic-database-password",
        "secret": "synthetic-secret",
        "service_credential": "synthetic-service-credential",
        "properties": {
            "token": {"type": "string", "description": "A tool parameter named token"},
            "secret": {"type": "string", "description": "A tool parameter named secret"},
        },
    }

    output = json.loads(scrub_tool_credentials("gen_ai.tool.definitions", json.dumps(input_value)))
    assert output["token"] == "[redacted]"
    assert output["api_token"] == "[redacted]"
    assert output["bearer_token"] == "[redacted]"
    assert output["refresh_token"] == "[redacted]"
    assert output["client_secret"] == "[redacted]"
    assert output["api_secret"] == "[redacted]"
    assert output["password"] == "[redacted]"
    assert output["database_password"] == "[redacted]"
    assert output["secret"] == "[redacted]"
    assert output["service_credential"] == "[redacted]"
    assert output["properties"] == input_value["properties"]
    assert output["server_url"] == (
        "https://mcp.example.test/gmail?token=%5Bredacted%5D&region=%5Bredacted%5D"
    )
    text = json.dumps(output)
    for credential in (
        "synthetic-user",
        "synthetic-password",
        "synthetic-query",
        "synthetic-region",
        "synthetic-token",
        "synthetic-api-token",
        "synthetic-bearer-token",
        "synthetic-refresh-token",
        "synthetic-client-secret",
        "synthetic-api-secret",
        "synthetic-database-password",
        "synthetic-secret",
        "synthetic-service-credential",
    ):
        assert credential not in text
    assert scrub_tool_credentials(
        "gen_ai.tool.definitions", json.dumps({"server_url": "https://[synthetic-secret"})
    ) == json.dumps({"server_url": "[redacted]"}, separators=(",", ":"))


def test_scrubs_nested_credential_schema_metadata():
    output = json.loads(
        scrub_tool_credentials(
            "gen_ai.tool.definitions",
            json.dumps(
                {
                    "type": "function",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "authorization": {
                                "anyOf": [{"type": "string", "default": "synthetic-default"}],
                                "examples": ["synthetic-example"],
                                "enum": ["synthetic-enum"],
                            },
                            "headers": {
                                "type": "object",
                                "properties": {
                                    "authorization": {
                                        "type": "string",
                                        "default": "synthetic-nested-header",
                                    },
                                    "region": {"type": "string", "default": "synthetic-region"},
                                },
                            },
                        },
                    },
                }
            ),
        )
    )
    assert output["parameters"]["properties"]["authorization"]["anyOf"][0]["default"] == (
        "[redacted]"
    )
    assert output["parameters"]["properties"]["authorization"]["examples"] == ["[redacted]"]
    assert output["parameters"]["properties"]["authorization"]["enum"] == ["[redacted]"]
    assert output["parameters"]["properties"]["headers"]["properties"] == {
        "authorization": {"type": "string", "default": "[redacted]"},
        "region": {"type": "string", "default": "synthetic-region"},
    }


def test_uses_utf8_bytes_for_the_shared_metadata_summary_budget():
    source = {
        "gen_ai.tool.definitions": json.dumps(
            [{"type": "function", "name": "synthetic", "description": "😀" * 600_000}]
        )
    }
    assert with_tool_catalog_summary(source) == source


def test_scrubs_url_fragments_schema_defaults_and_huge_integer_digest_inputs():
    definition = {
        "server_url": "https://mcp.example.test?token=synthetic#access_token=synthetic-fragment",
        "properties": {
            "authorization": {
                "type": "string",
                "default": "synthetic-default",
                "examples": ["synthetic-example"],
            }
        },
    }
    scrubbed = json.loads(scrub_tool_credentials("gen_ai.tool.definitions", json.dumps(definition)))
    assert scrubbed["server_url"] == "https://mcp.example.test/?token=%5Bredacted%5D"
    assert scrubbed["properties"]["authorization"]["default"] == "[redacted]"
    assert scrubbed["properties"]["authorization"]["examples"] == "[redacted]"
    assert "synthetic" not in json.dumps(scrubbed)
    sys.set_int_max_str_digits(20_000)
    source = {"gen_ai.tool.definitions": json.dumps([{"name": "big", "value": 10**4000}])}
    summary = with_tool_catalog_summary(source)
    assert summary["hue.tool.definitions.sha256"]


def test_scrubs_nested_credential_schema_metadata():
    output = json.loads(
        scrub_tool_credentials(
            "gen_ai.tool.definitions",
            json.dumps(
                {
                    "type": "function",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "authorization": {
                                "anyOf": [{"type": "string", "default": "synthetic-default"}],
                                "examples": ["synthetic-example"],
                                "enum": ["synthetic-enum"],
                            },
                            "headers": {
                                "type": "object",
                                "properties": {
                                    "authorization": {
                                        "type": "string",
                                        "default": "synthetic-nested-header",
                                    },
                                    "region": {"type": "string", "default": "synthetic-region"},
                                },
                            },
                        },
                    },
                }
            ),
        )
    )
    assert output["parameters"]["properties"]["authorization"]["anyOf"][0]["default"] == (
        "[redacted]"
    )
    assert output["parameters"]["properties"]["authorization"]["examples"] == ["[redacted]"]
    assert output["parameters"]["properties"]["authorization"]["enum"] == ["[redacted]"]
    assert output["parameters"]["properties"]["headers"]["properties"] == {
        "authorization": {"type": "string", "default": "[redacted]"},
        "region": {"type": "string", "default": "synthetic-region"},
    }
