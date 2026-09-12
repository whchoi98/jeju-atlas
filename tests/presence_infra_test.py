from pathlib import Path
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[1]


class Loader(yaml.SafeLoader):
    pass


def intrinsic(loader, tag, node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node, deep=True)
    else:
        value = loader.construct_mapping(node, deep=True)
    return {tag: value}


Loader.add_multi_constructor("!", intrinsic)


class PresenceInfrastructureTest(unittest.TestCase):
    def test_visitor_totals_have_an_independent_retained_table(self):
        template = yaml.load((ROOT / "infra/application.yaml").read_text(), Loader=Loader)
        resources = template["Resources"]
        table = resources["VisitorPresence"]
        self.assertEqual(table["Type"], "AWS::DynamoDB::Table")
        self.assertEqual(table["DeletionPolicy"], "Retain")
        self.assertEqual(table["UpdateReplacePolicy"], "Retain")
        properties = table["Properties"]
        self.assertNotEqual(properties["TableName"], resources["GuideQuota"]["Properties"]["TableName"])
        self.assertEqual(properties["BillingMode"], "PAY_PER_REQUEST")
        self.assertTrue(properties["DeletionProtectionEnabled"])
        self.assertTrue(properties["SSESpecification"]["SSEEnabled"])
        self.assertEqual(properties["TimeToLiveSpecification"], {"AttributeName": "expires_at", "Enabled": True})
        self.assertEqual(properties["KeySchema"], [
            {"AttributeName": "scope", "KeyType": "HASH"},
            {"AttributeName": "visitor", "KeyType": "RANGE"},
        ])
        web = next(c for c in resources["TaskDefinition"]["Properties"]["ContainerDefinitions"] if c["Name"] == "web")
        environment = {e["Name"]: e["Value"] for e in web["Environment"] if "Name" in e}
        self.assertEqual(environment["PRESENCE_TABLE"], {"Ref": "VisitorPresence"})
        self.assertEqual(environment["GUIDE_LIMITS_ENABLED"], {"Ref": "GuideLimitsEnabled"})

    def test_app_usage_limits_are_explicitly_controllable_without_changing_network_or_model(self):
        template = yaml.load((ROOT / "infra/application.yaml").read_text(), Loader=Loader)
        parameter = template["Parameters"]["GuideLimitsEnabled"]
        self.assertEqual(parameter["Default"], "true")
        self.assertEqual(set(parameter["AllowedValues"]), {"true", "false"})
        resources = template["Resources"]
        web = next(c for c in resources["TaskDefinition"]["Properties"]["ContainerDefinitions"] if c["Name"] == "web")
        environment = {e["Name"]: e["Value"] for e in web["Environment"] if "Name" in e}
        self.assertEqual(environment["GUIDE_RUNTIME_ARN"], {"Ref": "GuideRuntimeArn"})
        self.assertEqual(resources["TaskDefinition"]["Properties"]["NetworkMode"], "awsvpc")


if __name__ == "__main__":
    unittest.main()
