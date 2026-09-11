"""The PC handbook must be complete and contain no deployment state or credentials."""
import importlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "workshop/scripts"))


class HandbookPackageTests(unittest.TestCase):
    def module(self):
        self.assertTrue((ROOT / "workshop/scripts/package_handbook.py").exists(),
                        "The offline handbook packager is not implemented")
        return importlib.import_module("package_handbook")

    def fixture(self, root):
        site = root / "site"
        files = {
            "index.html": "<a href='chapters/00.html'>Start</a>",
            "chapters/00.html": "<a href='../prompts/00.md'>Codex card</a>",
            "assets/reader.css": "body{color:#232f3e}",
            "assets/fonts/OFL.txt": "Font license",
            "prompts/00.md": "# A Codex card\nRun commands on the workshop EC2.\n",
        }
        for name, content in files.items():
            path = site / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        (site / ".workshop-site.json").write_text(json.dumps({
            "generator": "jeju-atlas-workshop/v1", "pages": ["index.html", "chapters/00.html"]}))
        return site, files

    def test_bundle_preserves_pages_assets_and_prompt_cards_under_one_directory(self):
        module = self.module()
        with tempfile.TemporaryDirectory(prefix="atlas-handbook-") as directory:
            root = Path(directory)
            site, files = self.fixture(root)
            output = root / "downloads/handbook.zip"
            report = module.package_handbook(site, output)
            with zipfile.ZipFile(output) as archive:
                for name, content in files.items():
                    self.assertEqual(archive.read("jeju-atlas-workshop/" + name).decode(), content)
                self.assertIn("jeju-atlas-workshop/START-HERE.txt", archive.namelist())
                self.assertFalse(any(".local" in name or ".env" in name for name in archive.namelist()))
            self.assertEqual(report["entryPoint"], "jeju-atlas-workshop/index.html")
            self.assertEqual(len(report["sha256"]), 64)
            self.assertTrue(output.with_suffix(".zip.sha256").is_file())

    def test_missing_page_rejects_the_package_before_output(self):
        module = self.module()
        with tempfile.TemporaryDirectory(prefix="atlas-handbook-") as directory:
            root = Path(directory)
            site, _ = self.fixture(root)
            (site / "chapters/00.html").unlink()
            output = root / "handbook.zip"
            with self.assertRaises(ValueError):
                module.package_handbook(site, output)
            self.assertFalse(output.exists())

    def test_private_or_unexpected_files_and_symlinks_are_not_exported(self):
        module = self.module()
        for private in [".env", ".local/config.json", "credentials.json"]:
            with self.subTest(private=private), tempfile.TemporaryDirectory(prefix="atlas-handbook-") as directory:
                root = Path(directory)
                site, _ = self.fixture(root)
                file = site / private
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("do not export")
                with self.assertRaises(ValueError):
                    module.package_handbook(site, root / "handbook.zip")
        with tempfile.TemporaryDirectory(prefix="atlas-handbook-") as directory:
            root = Path(directory)
            site, _ = self.fixture(root)
            (site / "assets/external.txt").symlink_to(root / "outside")
            with self.assertRaises(ValueError):
                module.package_handbook(site, root / "handbook.zip")

    def test_archive_cannot_be_written_inside_the_site(self):
        module = self.module()
        with tempfile.TemporaryDirectory(prefix="atlas-handbook-") as directory:
            root = Path(directory)
            site, _ = self.fixture(root)
            with self.assertRaises(ValueError):
                module.package_handbook(site, site / "handbook.zip")


if __name__ == "__main__":
    unittest.main()
