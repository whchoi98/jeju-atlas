"""Independent source/packaging checks; no reference checkout, credentials or network."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import tomllib
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def load_file(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CodeZipIsolation(unittest.TestCase):
    def test_frozen_lock_resolves_each_local_project_and_declared_readme(self):
        for component in ("guide", "tools"):
            with self.subTest(component=component):
                root = ROOT / "agent" / component
                project = tomllib.loads((root / "pyproject.toml").read_text())["project"]
                lock = tomllib.loads((root / "uv.lock").read_text())
                editable = [package for package in lock["package"] if package.get("source", {}).get("editable") == "."]
                normalized = re.sub(r"[-_.]+", "-", project["name"]).lower()
                self.assertEqual([package["name"] for package in editable], [normalized])
                self.assertEqual(editable[0]["version"], project["version"])
                self.assertTrue((root / project["readme"]).is_file(), "building this project must not require a missing README")

    def test_tool_names_survive_the_privacy_allowlist_in_both_codezips(self):
        for component, package in (("guide", "atlas_agent"), ("tools", "atlas_tools")):
            with self.subTest(component=component):
                privacy = load_file(f"privacy_{component}", ROOT / "agent" / component / package / "privacy.py")
                for tool in ("find_places", "place_detail", "plan_day", "route", "weather", "sun_times", "layer", "festivals"):
                    self.assertEqual(privacy.safe_tool_name(f"jejuatlastools_{tool}"), f"jejuatlastools_{tool}")
                self.assertEqual(privacy.safe_tool_name("ohmyjejutools_find_places"), "unknown")
                self.assertEqual(privacy.safe_tool_name("jejuatlastools_private-sentinel"), "unknown")

    def test_packaged_catalog_wins_over_unrelated_parent_repository_data(self):
        with tempfile.TemporaryDirectory(prefix="atlas-package-") as temporary:
            root = Path(temporary)
            package = root / "repository" / "tools"
            (package / "data").mkdir(parents=True)
            (root / "data").mkdir()
            shutil.copyfile(ROOT / "agent/tools/catalog.py", package / "catalog.py")
            shutil.copyfile(ROOT / "agent/tools/data/jeju_pois.json", package / "data/jeju_pois.json")
            (root / "data/jeju_pois.json").write_text('[]')
            catalog = load_file("atlas_isolated_catalog", package / "catalog.py")
            self.assertEqual(catalog._sample_path(), package / "data/jeju_pois.json")
            with patch.dict(os.environ, {"ATLAS_CATALOG_CACHE_DIR": str(root / "cache")}, clear=True):
                path = catalog.ensure_local_catalog()
                self.assertEqual(path.parent, root / "cache")
                store = catalog.Catalog(path)
                try:
                    place = store.get("poi_0008")
                    self.assertEqual(place["name"], "성산일출봉")
                    self.assertEqual(place["source"], "sample")
                finally:
                    store.close()
            (package / "data/jeju_pois.json").unlink()
            self.assertIsNone(catalog._sample_path(), "missing packaged data must not activate an unrelated repository")

    def test_only_atlas_catalog_environment_selects_remote_data_and_cache(self):
        catalog = load_file("atlas_catalog_configuration", ROOT / "agent/tools/catalog.py")
        with patch.dict(os.environ, {
            "CATALOG_BUCKET": "unrelated-project-catalog",
            "OHMYJEJU_CATALOG_BUCKET": "unrelated-reference-catalog",
            "CATALOG_CACHE_DIR": "/tmp/unrelated-project",
        }, clear=True):
            self.assertIsNone(catalog.catalog_bucket())
            self.assertEqual(catalog._cache_dir(), Path("/tmp/atlas"))
            os.environ["ATLAS_CATALOG_BUCKET"] = "jeju-atlas-fixture-catalog"
            os.environ["ATLAS_CATALOG_CACHE_DIR"] = "/tmp/atlas-fixture"
            self.assertEqual(catalog.catalog_bucket(), "jeju-atlas-fixture-catalog")
            self.assertEqual(catalog._cache_dir(), Path("/tmp/atlas-fixture"))

    def test_unset_atlas_ssm_prefix_cannot_use_legacy_secret_configuration(self):
        secrets = load_file("atlas_secrets_configuration", ROOT / "agent/tools/atlas_tools/external/secrets_ssm.py")
        with patch.dict(os.environ, {"OHMYJEJU_SECRETS_SSM_PREFIX": "/unrelated/secrets/"}, clear=True):
            with patch.object(secrets, "_client", side_effect=AssertionError("SSM must not be contacted")):
                self.assertIsNone(secrets.lookup("KAKAO_REST_API_KEY"))

    def test_shipped_permission_templates_cannot_grant_access_to_reference_resources(self):
        for path in (ROOT / "agent").glob("*/policies/*.json"):
            policy = json.loads(path.read_text())
            for statement in policy.get("Statement", []):
                resources = statement.get("Resource", [])
                if isinstance(resources, str):
                    resources = [resources]
                if statement.get("Effect") == "Allow":
                    self.assertFalse(any("ohmyjeju" in resource.lower() for resource in resources), path.name)


if __name__ == "__main__":
    unittest.main()
