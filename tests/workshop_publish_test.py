"""The existing-service publisher cannot change application code or infrastructure."""
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/publish-workshop.py"


class WorkshopPublishTests(unittest.TestCase):
    def module(self):
        self.assertTrue(SCRIPT.is_file(), "The narrow workshop publisher is missing")
        sys.path.insert(0, str(ROOT / "scripts"))
        spec = importlib.util.spec_from_file_location("workshop_publish_test_module", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_only_the_existing_web_image_parameter_changes(self):
        module = self.module()
        values = [{"ParameterKey": "ImageUri", "ParameterValue": "old"},
                  {"ParameterKey": "ViewerDomainName", "ParameterValue": "existing.example.org"},
                  {"ParameterKey": "DesiredCount", "ParameterValue": "2"},
                  {"ParameterKey": "Release", "ParameterValue": "existing-release"}]
        result = module.update_parameters(values, "new")
        self.assertEqual(result, [
            {"ParameterKey": "ImageUri", "ParameterValue": "new"},
            {"ParameterKey": "ViewerDomainName", "UsePreviousValue": True},
            {"ParameterKey": "DesiredCount", "UsePreviousValue": True},
            {"ParameterKey": "Release", "UsePreviousValue": True},
        ])

    def test_changeset_rejects_creation_security_domains_and_other_resources(self):
        module = self.module()
        allowed = [
            {"ResourceChange": {"Action": "Modify", "LogicalResourceId": "TaskDefinition", "ResourceType": "AWS::ECS::TaskDefinition"}},
            {"ResourceChange": {"Action": "Modify", "LogicalResourceId": "Service", "ResourceType": "AWS::ECS::Service"}},
        ]
        module.validate_changes(allowed)
        for change in [
            {"Action": "Add", "LogicalResourceId": "TaskDefinition", "ResourceType": "AWS::ECS::TaskDefinition"},
            {"Action": "Remove", "LogicalResourceId": "Service", "ResourceType": "AWS::ECS::Service"},
            {"Action": "Modify", "LogicalResourceId": "TaskRole", "ResourceType": "AWS::IAM::Role"},
            {"Action": "Modify", "LogicalResourceId": "Distribution", "ResourceType": "AWS::CloudFront::Distribution"},
        ]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                module.validate_changes(allowed + [{"ResourceChange": change}])

    def test_only_workshop_files_can_differ_between_images(self):
        module = self.module()
        before = {"app/server/server.mjs": "unchanged", "app/dist/index.html": "app",
                  "app/dist/workshop/index.html": "old"}
        after = {**before, "app/dist/workshop/index.html": "new"}
        self.assertEqual(module.validate_file_diff(before, after), ["app/dist/workshop/index.html"])
        for bad in ({**after, "app/server/server.mjs": "changed"}, {"app/dist/workshop/index.html": "new"}):
            with self.assertRaises(ValueError):
                module.validate_file_diff(before, bad)

    def test_unchanged_content_is_not_reported_as_a_publication(self):
        module = self.module()
        with self.assertRaises(ValueError):
            module.validate_file_diff({"app/dist/workshop/index.html": "same"},
                                      {"app/dist/workshop/index.html": "same"})

    def test_changed_domain_parameter_is_rejected_even_when_resource_list_looks_safe(self):
        module = self.module()
        old = [{"ParameterKey": "ImageUri", "ParameterValue": "old"},
               {"ParameterKey": "ViewerDomainName", "ParameterValue": "existing.example.org"}]
        module.validate_plan_parameters({"Parameters": [
            {"ParameterKey": "ImageUri", "ParameterValue": "new"},
            {"ParameterKey": "ViewerDomainName", "UsePreviousValue": True},
        ]}, old, "new")
        with self.assertRaises(ValueError):
            module.validate_plan_parameters({"Parameters": [
                {"ParameterKey": "ImageUri", "ParameterValue": "new"},
                {"ParameterKey": "ViewerDomainName", "ParameterValue": "other.example.org"},
            ]}, old, "new")


if __name__ == "__main__":
    unittest.main()
