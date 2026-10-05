"""Saving a Codex build checkpoint must not authorize a Vercel deployment."""
import json
from pathlib import Path
import unittest


class VercelCheckpointTests(unittest.TestCase):
    def test_both_possible_project_roots_disable_only_codex_git_deployments(self):
        repository = Path(__file__).resolve().parents[2]
        for relative in ("vercel.json", "apps/web/vercel.json"):
            with self.subTest(config=relative):
                config = json.loads((repository / relative).read_text(encoding="utf-8"))
                self.assertEqual(config["git"]["deploymentEnabled"], {"codex/**": False})
                self.assertEqual(config["version"], 2)
                self.assertTrue(config["builds"], "Existing build configuration must remain available")


if __name__ == "__main__":
    unittest.main()
