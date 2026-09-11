"""All three developer CLIs share the same deployment boundary."""
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "workshop/scripts"))
sys.path.insert(0, str(Path(__file__).parent))
import lab
from lab_workspace import prepare_workspace
from test_lab_boundary import configuration


class AICLIEnvironmentTests(unittest.TestCase):
    def test_doctor_requires_only_the_selected_assistant(self):
        versions = {"node": "v24.21.0", "agentcore": "0.28.1", "kiro-cli": "kiro-cli 2.21.2",
                    "claude": "2.1.197 (Claude Code)", "codex": "codex-cli 0.136.0"}
        for selected, binary in [("codex", "codex"), ("kiro", "kiro-cli"), ("claude", "claude")]:
            with self.subTest(selected=selected):
                with patch.object(lab.shutil, "which", return_value="/test/tool"), \
                        patch.object(lab.subprocess, "run", side_effect=lambda command, **kwargs:
                                     SimpleNamespace(returncode=0, stdout=versions.get(command[0], "1.0"), stderr="")):
                    result = lab.doctor(configuration(), False, assistant=selected)
                tools = {row["tool"] for row in result["tools"]}
                self.assertTrue(result["passed"])
                self.assertEqual(result["assistant"], selected)
                self.assertIn(binary, tools)
                self.assertEqual(tools & {"codex", "kiro-cli", "claude"}, {binary})

    def test_generated_workspace_has_project_local_guidance_for_all_clis(self):
        with tempfile.TemporaryDirectory(prefix="atlas-cli-guidance-") as directory:
            app = prepare_workspace(configuration(), ROOT, Path(directory))
            self.assertTrue((app / "CLAUDE.md").is_file())
            self.assertIn("@AGENTS.md", (app / "CLAUDE.md").read_text())
            steering = app / ".kiro/steering/workshop.md"
            self.assertTrue(steering.is_file())
            self.assertIn("inclusion: always", steering.read_text())
            self.assertIn("jeju-atlas-lab-team01", steering.read_text())
            self.assertFalse(steering.is_symlink())


if __name__ == "__main__":
    unittest.main()
