from __future__ import annotations

import json

from hue_sdk._tool_definitions import scrub_tool_credentials


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
                                "anyOf": [{"type": "string", "default": "synthetic-default"}]
                            }
                        },
                    },
                }
            ),
        )
    )
    assert output["parameters"]["properties"]["authorization"]["anyOf"][0]["default"] == (
        "[redacted]"
    )
