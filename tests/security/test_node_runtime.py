"""The declared production runtime must support the locked Supabase SDK."""
import json
from pathlib import Path
import unittest


class NodeRuntimeTests(unittest.TestCase):
    def test_root_and_lockfile_require_the_supported_node_floor(self):
        repository = Path(__file__).resolve().parents[2]
        package = json.loads((repository / "package.json").read_text(encoding="utf-8"))
        lock = json.loads((repository / "package-lock.json").read_text(encoding="utf-8"))
        self.assertEqual(package["engines"]["node"], ">=22")
        self.assertEqual(lock["packages"][""]["engines"], package["engines"])
        self.assertEqual(
            lock["packages"]["node_modules/@supabase/supabase-js"]["engines"]["node"],
            ">=22.0.0",
            "Review the application runtime floor if the SDK changes its requirement",
        )


if __name__ == "__main__":
    unittest.main()
