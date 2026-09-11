"""Behavioral checks for deployment isolation and first-install dependencies."""
import importlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "workshop/scripts"))


def configuration():
    return {
        "version": 1,
        "participant": "team01",
        "accountId": "123456789012",
        "region": "ap-northeast-2",
        "profile": "",
        "vpcName": "training-vpc",
        "network": {
            "vpcId": "vpc-00000000000000001",
            "publicSubnetIds": ["subnet-00000000000000001", "subnet-00000000000000002"],
            "privateSubnetIds": ["subnet-00000000000000003", "subnet-00000000000000004"],
            "cloudFrontPrefixListId": "pl-00000000000000001",
        },
        "domainName": "",
        "viewerCertificateArn": "",
    }


class BoundaryTests(unittest.TestCase):
    def modules(self):
        self.assertTrue((ROOT / "workshop/scripts/lab_config.py").exists(),
                        "The workshop configuration boundary is not implemented")
        return importlib.import_module("lab_config"), importlib.import_module("lab_workspace")

    def test_derived_names_do_not_claim_production_resources(self):
        config, _ = self.modules()
        value = config.validate_config(configuration(), require_network=True)
        names = config.resource_names(value)
        self.assertEqual(names["project"], "jeju-atlas-lab-team01")
        self.assertEqual(names["stackPrefix"], "AtlasLabTeam01")
        self.assertEqual(names["corePrefix"], "AtlasLabTeam01")
        self.assertEqual(names["cliProject"], "AtlasCliTeam01")
        self.assertLessEqual(len(names["dataBucket"]), 63)

    def test_invalid_account_region_names_and_secrets_are_rejected(self):
        config, _ = self.modules()
        for field, bad in [
            ("participant", "../jeju-3d"), ("participant", "prod"),
            ("participant", "team01; echo bad"), ("accountId", "000"),
            ("region", "us-east-1"), ("apiKey", "must-not-be-written"),
            ("domainName", "jeju-atlas.whchoi.net"),
        ]:
            with self.subTest(field=field, value=bad):
                value = configuration()
                value[field] = bad
                with self.assertRaises(ValueError):
                    config.validate_config(value)

    def test_subnets_cannot_overlap_or_be_incomplete(self):
        config, _ = self.modules()
        value = configuration()
        value["network"]["privateSubnetIds"][0] = value["network"]["publicSubnetIds"][0]
        with self.assertRaises(ValueError):
            config.validate_config(value, require_network=True)
        value["network"] = {}
        with self.assertRaises(ValueError):
            config.validate_config(value, require_network=True)

    def test_prepared_assets_use_only_the_new_namespace(self):
        config, workspace = self.modules()
        value = config.validate_config(configuration(), require_network=True)
        with tempfile.TemporaryDirectory(prefix="atlas-workshop-") as directory:
            app = workspace.prepare_workspace(value, ROOT, Path(directory))
            deploy = (app / "scripts/deploy.py").read_text()
            agent = (app / "scripts/deploy-atlas-agent.py").read_text()
            for text in [deploy, agent]:
                self.assertNotIn("061525506239", text)
                self.assertNotIn("Jeju3d", text)
                self.assertNotIn("JejuAtlas_Guide", text)
                self.assertNotIn('"jeju-3d"', text)
            self.assertIn('ACCOUNT = "123456789012"', deploy)
            self.assertIn('VPC = "vpc-00000000000000001"', deploy)
            self.assertIn("AtlasLabTeam01_Guide", agent)
            self.assertFalse((app / ".local/atlas-agent-outputs.json").exists())
            self.assertFalse((app / ".env").exists())
            self.assertFalse((app / "agent/dependency-artifacts.json").exists())
            self.assertEqual((app / "src/main.ts").read_bytes(), (ROOT / "src/main.ts").read_bytes())
            self.assertFalse((app / "node_modules").exists())
            for name in ["course.json", "scripts/build.mjs", "scripts/package_handbook.py",
                         "assets/reader.js"]:
                self.assertTrue((app / "workshop" / name).is_file(), name)
            self.assertFalse((app / "workshop/.local").exists())
            self.assertFalse((app / "workshop/cli").exists())
            self.assertFalse((app / "workshop/site").exists())
            collector = (app / "scripts/fetch-place-details.py").read_text()
            data_template = (app / "infra/data.yaml").read_text()
            self.assertNotIn("/jeju-atlas/", collector)
            self.assertNotIn("parameter/jeju-atlas/", data_template)
            self.assertIn("/jeju-atlas-lab-team01/tourapi-service-key", collector)

    def test_first_data_stack_has_no_fake_distribution_or_public_access(self):
        config, workspace = self.modules()
        with tempfile.TemporaryDirectory(prefix="atlas-workshop-") as directory:
            app = workspace.prepare_workspace(
                config.validate_config(configuration(), require_network=True), ROOT, Path(directory))
            template = workspace.read_template(app / "infra/data.yaml")
            self.assertEqual(template["Parameters"]["DistributionArn"]["Default"], "")
            self.assertIn("HasDistribution", template["Conditions"])
            statements = template["Resources"]["DetailsBucketPolicy"]["Properties"]["PolicyDocument"]["Statement"]
            conditional = [statement for statement in statements if "Fn::If" in statement]
            self.assertEqual(len(conditional), 1)
            self.assertEqual(conditional[0]["Fn::If"][0], "HasDistribution")
            public = template["Resources"]["DetailsBucket"]["Properties"]["PublicAccessBlockConfiguration"]
            self.assertTrue(all(public.values()))
            self.assertNotIn("WORKSHOP-PENDING", json.dumps(template))

    def test_repeat_prepare_does_not_overwrite_student_work(self):
        config, workspace = self.modules()
        value = config.validate_config(configuration(), require_network=True)
        with tempfile.TemporaryDirectory(prefix="atlas-workshop-") as directory:
            app = workspace.prepare_workspace(value, ROOT, Path(directory))
            marker = app / "student-notes.txt"
            marker.write_text("keep this work")
            with self.assertRaises(FileExistsError):
                workspace.prepare_workspace(value, ROOT, Path(directory))
            self.assertEqual(marker.read_text(), "keep this work")


if __name__ == "__main__":
    unittest.main()
