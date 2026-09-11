from pathlib import Path
import unittest
import yaml


class Loader(yaml.SafeLoader):
    pass


def intrinsic(loader, tag, node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node)
    else:
        value = loader.construct_mapping(node)
    return {tag: value}


Loader.add_multi_constructor("!", intrinsic)
root = Path(__file__).resolve().parents[1]


class DataInfrastructureTests(unittest.TestCase):
    def setUp(self):
        self.template = yaml.load((root / "infra/data.yaml").read_text(), Loader=Loader)
        self.resources = self.template["Resources"]

    def test_data_stays_private_and_cloudfront_can_read_only_media(self):
        bucket = self.resources["DetailsBucket"]["Properties"]
        self.assertTrue(all(bucket["PublicAccessBlockConfiguration"].values()))
        self.assertEqual(bucket["VersioningConfiguration"]["Status"], "Enabled")
        statements = self.resources["DetailsBucketPolicy"]["Properties"]["PolicyDocument"]["Statement"]
        public = [item for item in statements if item["Effect"] == "Allow"]
        self.assertEqual(len(public), 1)
        self.assertEqual(public[0]["Principal"], {"Service": "cloudfront.amazonaws.com"})
        self.assertEqual(public[0]["Action"], "s3:GetObject")
        self.assertTrue(public[0]["Resource"]["Sub"].endswith("/media/*"))
        self.assertIn("AWS:SourceArn", public[0]["Condition"]["StringEquals"])

    def test_worker_has_only_the_two_named_secret_parameters_and_never_writes_the_base_catalog(self):
        policy = self.resources["WorkerRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"]
        secret = next(item for item in policy if item["Action"] == "ssm:GetParameters")
        self.assertEqual(len(secret["Resource"]), 2)
        for resource in secret["Resource"]:
            self.assertIn(":parameter/jeju-atlas/", resource["Sub"])
            self.assertNotIn("*", resource["Sub"])
        base = next(item for item in policy if item["Action"] == "s3:GetObject")
        self.assertIn("${CatalogBucket}/catalog/catalog.sqlite", base["Resource"]["Sub"])
        self.assertFalse(any("s3:DeleteObject" in item["Action"] for item in policy))

    def test_job_reuses_private_subnets_and_has_no_public_ip_or_automatic_retry(self):
        target = self.resources["RefreshSchedule"]["Properties"]["Target"]
        network = target["EcsParameters"]["NetworkConfiguration"]["AwsvpcConfiguration"]
        self.assertEqual(network["AssignPublicIp"], "DISABLED")
        self.assertEqual(network["Subnets"], {"Ref": "PrivateSubnetIds"})
        self.assertEqual(target["RetryPolicy"]["MaximumRetryAttempts"], 0)
        self.assertEqual(self.template["Parameters"]["ScheduleState"]["Default"], "DISABLED")
        for item in self.resources.values():
            self.assertNotIn(item["Type"], ("AWS::EC2::VPC", "AWS::EC2::Subnet", "AWS::EC2::NatGateway"))

    def test_execution_roles_can_pull_the_guardduty_agent_without_wildcard_repositories(self):
        guardduty = {"Sub": "arn:${AWS::Partition}:ecr:${AWS::Region}:914738172881:repository/aws-guardduty-agent-fargate"}
        app = yaml.load((root / "infra/application.yaml").read_text(), Loader=Loader)
        for resources, role_name in ((self.resources, "WorkerExecutionRole"), (app["Resources"], "ExecutionRole")):
            with self.subTest(role=role_name):
                statements = [statement for policy in resources[role_name]["Properties"]["Policies"]
                              for statement in policy["PolicyDocument"]["Statement"]]
                pull = [item for item in statements if "ecr:BatchGetImage" in item.get("Action", [])]
                self.assertEqual(len(pull), 1)
                self.assertEqual(set(pull[0]["Action"]), {
                    "ecr:BatchGetImage", "ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer",
                })
                self.assertEqual(len(pull[0]["Resource"]), 2)
                self.assertIn(guardduty, pull[0]["Resource"])
                self.assertNotIn("*", str(pull[0]["Resource"]))


if __name__ == "__main__":
    unittest.main()
