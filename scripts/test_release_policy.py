"""No registry operations: validate candidate/default/dry-run release choices."""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("policy", Path(__file__).with_name("release-policy.py"))
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class ReleasePolicyTests(unittest.TestCase):
    def test_ordinary_release_defaults_unchanged(self):
        module.validate("typescript", "0.3.2", "latest", True, "")
        module.validate("python", "0.2.2", "latest", True, "")

    def test_publish_false_does_not_require_publication_prerequisites(self):
        module.validate("typescript", "0.4.0", "latest", False, "")
        module.validate("typescript", "0.4.0", "hue-onboarding-candidate", False, "")

    def test_onboarding_publication_requires_candidate_and_accepted_prior_run(self):
        module.validate("typescript", "0.4.0", "hue-onboarding-candidate", True, "1234")
        for tag, run_id in (("latest", "1234"), ("hue-onboarding-candidate", ""), ("latest", "")):
            with self.assertRaises(ValueError):
                module.validate("typescript", "0.4.0", tag, True, run_id)

    def test_tags_versions_and_run_ids_are_closed(self):
        for value in ("next", "--latest", "latest;echo", "1.0", ""):
            with self.assertRaises(ValueError):
                module.validate("typescript", "0.4.0", value, False, "")
        for value in ("-1", "0", "1;echo", "a", "123\n"):
            with self.assertRaises(ValueError):
                module.validate("typescript", "0.4.0", "hue-onboarding-candidate", True, value)
        with self.assertRaises(ValueError):
            module.validate("python", "0.2.2", "latest", False, "123")
