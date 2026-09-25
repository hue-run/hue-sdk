"""Generate planted-secrets.json: provider error texts with a synthetic secret planted in each place
the error-text scrubber redacts, for both SDKs' suites to check that every one is redacted.

Deterministic for a seed: python3 planted-secrets.py [--seed N] [--per-family N] [--out PATH]
"""

from __future__ import annotations

import argparse
import json
import random
import string
from pathlib import Path

ALNUM = string.ascii_letters + string.digits
KEYS = [
    "token", "password", "secret", "api_key", "apiKey", "api-key", "access_token", "accessToken",
    "client_secret", "refresh_token", "x-api-key", "auth_token", "credentials", "--token",
    "--password", "--api-key", "_authToken", "_token", "authorization_token", "db_password",
]
SEPARATORS = ["=", ":", ": ", " = ", " : ", "\t:\t", "= "]
SCHEMES = ["Bearer", "Basic", "Token", "bearer", "token"]
HEADER_SCHEMES = ["Bearer", "Basic", "Token", "Bot", "ApiKey", "Api-Key", "OAuth1", "Digest",
                  "AWS4-HMAC-SHA256", "DPoP"]
PREFIXES = ["sk-", "sk-proj-", "sk-ant-api03-", "ghp_", "gho_", "github_pat_", "glpat-", "xoxb-",
            "xoxp-", "xoxc-", "xoxd-", "xapp-", "ya29.", "sk_live_", "rk_test_", "hue_sk_",
            "hue_mcp_", "hue_world_", "hue_attempt_", "hue_sim_", "hue_setup_", "hue_install_",
            "hue_inv_"]
GLUE = ["(", "{", "[", "~", "!", ":", "|", "<", " "]
PROSE = ["upstream rejected the request", "the MCP server said", "retry after 30s", "error:",
         "failed with 401", "see the logs", "request id 7f3a", "while calling search_threads",
         "HTTP/1.1 403 Forbidden", "please check your configuration", "at line 12", "->"]
SPECIAL_URLS = ["https", "http", "wss", "ftp"]


def secret(rng: random.Random) -> str:
    """A credential-looking value that no rule could mistake for anything but its whole self. The
    `.` keeps a prefixed token from matching a real provider's format, which secret scanners flag."""
    return "Sx." + "".join(rng.choice(ALNUM) for _ in range(rng.randint(10, 18)))


def families(rng: random.Random):
    """Each family returns (text, planted secrets)."""

    def pair():
        value = secret(rng)
        return f"{rng.choice(KEYS)}{rng.choice(SEPARATORS)}{value}", [value]

    def quoted_pair():
        first, second = secret(rng), secret(rng)
        key = rng.choice(KEYS)
        text = rng.choice(
            [
                f'"{key}": "{first} {second}"',
                f"'{key}': '{first} {second}'",
                f'{key}="{first} {second}"',
                f'{{"error":"denied","{key}":"{first} {second}","n":1}}',
            ]
        )
        return text, [first, second]

    def escaped_json():
        value = secret(rng)
        key = rng.choice(KEYS)
        return f'body {{\\"{key}\\":\\"{value}\\",\\"user\\":\\"bob\\"}}', [value]

    def header():
        value = secret(rng)
        name = rng.choice(["Authorization", "authorization", "Proxy-Authorization"])
        separator = rng.choice([": ", ":", "=", " : "])
        return f"{name}{separator}{rng.choice(HEADER_SCHEMES)} {value}", [value]

    def scheme_in_prose():
        value = secret(rng)
        scheme = rng.choice(SCHEMES)
        form = rng.choice([f"{scheme} {value}", f"{scheme}: {value}", f"{scheme} : {value}"])
        return f"{rng.choice(PROSE)} {form} {rng.choice(PROSE)}", [value]

    def url():
        value = secret(rng)
        host = rng.choice(["mcp.example.test", "api.example.test:8443", "mcp_server:8080"])
        scheme = rng.choice(SPECIAL_URLS)
        text = rng.choice(
            [
                f"{scheme}://user:{value}@{host}/sse",
                f"{scheme}://{host}/p?{rng.choice(['key', 'sig', 'q', 'token'])}={value}&x=1",
                f"{scheme}://{host}/?token=\"{value}\" next",
                f"{scheme}://{host}/cb#access_token={value}",
                f"postgres://app:{value}@db.example.test/app",
                f"redis://:{value}@cache.example.test:6379/0",
            ]
        )
        return f"{rng.choice(PROSE)} {text}", [value]

    def prefixed():
        value = secret(rng)
        return f"{rng.choice(PROSE)} {rng.choice(PREFIXES)}{value} {rng.choice(PROSE)}", [value]

    def nested_pair():
        outer, inner = secret(rng), secret(rng)
        key = rng.choice(KEYS)
        glue = rng.choice(["!", "~", "/", "|", "+"])
        return (
            f"{key}={rng.choice(PREFIXES)}{outer}{glue}authorization={rng.choice(HEADER_SCHEMES)} "
            f"{inner}",
            [outer, inner],
        )

    def glued_scheme():
        outer, inner = secret(rng), secret(rng)
        key = rng.choice(KEYS)
        glue = rng.choice(GLUE)
        return f"{key}={outer}{glue}{rng.choice(SCHEMES)} {inner}", [outer, inner]

    def trailing_scheme():
        outer, inner = secret(rng), secret(rng)
        prefix = rng.choice(PREFIXES)
        glue = rng.choice(["~", ":", "-", "."])
        return (
            f"Invalid token {prefix}{outer}:x{glue}{rng.choice(['bearer', 'basic', 'token'])} {inner}",
            [outer, inner],
        )

    def api_key_phrase():
        value = secret(rng)
        return f"{rng.choice(PROSE)} API key: {value} {rng.choice(PROSE)}", [value]

    def glued_key():
        first, second = secret(rng), secret(rng)
        prefix = rng.choice(PREFIXES)
        key = rng.choice(["password", "token", "secret"])
        return f'{prefix}{first}X{key}: "{second} and more"', [first, second]

    return [pair, quoted_pair, escaped_json, header, scheme_in_prose, url, prefixed, nested_pair,
            glued_scheme, trailing_scheme, api_key_phrase, glued_key]


def generate(seed: int, per_family: int) -> dict:
    rng = random.Random(seed)
    cases = []
    for family in families(rng):
        for _ in range(per_family):
            text, secrets = family()
            # Surround the planted text with prose, as an error message would.
            before = rng.choice(["", rng.choice(PROSE) + " "])
            after = rng.choice(["", " " + rng.choice(PROSE), "; " + rng.choice(PROSE)])
            cases.append({"family": family.__name__, "input": before + text + after,
                          "secrets": secrets})
    return {"seed": seed, "cases": cases}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=20260925)
    parser.add_argument("--per-family", type=int, default=200)
    parser.add_argument("--out", type=Path, default=Path(__file__).with_suffix(".json"))
    args = parser.parse_args()
    corpus = generate(args.seed, args.per_family)
    # One case per line: compact, and a change shows as the cases it touches.
    lines = ",\n".join(json.dumps(case, ensure_ascii=True) for case in corpus["cases"])
    text = f'{{"seed": {corpus["seed"]}, "cases": [\n{lines}\n]}}\n'
    args.out.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
