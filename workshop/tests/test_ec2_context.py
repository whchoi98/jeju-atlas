"""The workshop must bind to this EC2's account and VPC without reading credentials."""
import importlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "workshop/scripts"))


class EC2ContextTests(unittest.TestCase):
    def module(self):
        self.assertTrue((ROOT / "workshop/scripts/ec2_context.py").exists(),
                        "EC2 metadata discovery is not implemented")
        return importlib.import_module("ec2_context")

    def context(self):
        return {"accountId": "123456789012", "region": "ap-northeast-2",
                "instanceId": "i-00000000000000001", "vpcId": "vpc-00000000000000001"}

    def test_imdsv2_reads_only_identity_and_primary_vpc(self):
        module = self.module()
        responses = []
        for value in [
            b"private-imds-session",
            b'{"accountId":"123456789012","region":"ap-northeast-2","instanceId":"i-00000000000000001"}',
            b"02:11:22:33:44:55",
            b"vpc-00000000000000001",
        ]:
            response = Mock(status_code=200, content=value)
            responses.append(response)
        http = Mock()
        http.request.side_effect = responses
        result = module.read_ec2_context(http)
        self.assertEqual(result, self.context())
        self.assertNotIn("token", str(result).lower())
        requests = http.request.call_args_list
        self.assertEqual(requests[0].args[0], "PUT")
        for request in requests:
            self.assertFalse(request.kwargs["allow_redirects"])
            self.assertTrue(request.args[1].startswith("http://169.254.169.254/latest/"))
            self.assertNotIn("security-credentials", request.args[1])
            self.assertNotIn("user-data", request.args[1])
        self.assertEqual(requests[-1].args[1].split("/latest/")[1],
                         "meta-data/network/interfaces/macs/02:11:22:33:44:55/vpc-id")

    def test_metadata_failure_has_no_default_account_or_vpc_fallback(self):
        module = self.module()
        http = Mock()
        http.request.return_value = Mock(status_code=403, content=b"private-token-in-error")
        with self.assertRaises(ValueError) as raised:
            module.read_ec2_context(http)
        self.assertNotIn("private-token", str(raised.exception))
        self.assertIn("EC2", str(raised.exception))
        self.assertEqual(http.request.call_count, 1)

    def test_metadata_vpc_is_frozen_in_configuration_and_fingerprint(self):
        module = self.module()
        from lab_config import binding_digest, validate_config
        config = module.configuration_for_ec2("team01", self.context())
        self.assertEqual(config["accountId"], self.context()["accountId"])
        self.assertEqual(config["ec2Context"], self.context())
        config["network"] = {
            "vpcId": self.context()["vpcId"],
            "publicSubnetIds": ["subnet-00000000000000001", "subnet-00000000000000002"],
            "privateSubnetIds": ["subnet-00000000000000003", "subnet-00000000000000004"],
            "cloudFrontPrefixListId": "pl-00000000000000001",
        }
        digest = binding_digest(config)
        config["ec2Context"]["instanceId"] = "i-00000000000000002"
        self.assertNotEqual(digest, binding_digest(config))
        config["network"]["vpcId"] = "vpc-00000000000000002"
        with self.assertRaises(ValueError):
            validate_config(config, require_network=True)

    def test_ec2_discovery_uses_vpc_id_even_without_a_name_tag(self):
        module = self.module()
        from lab_config import discover_network
        config = module.configuration_for_ec2("team01", self.context())
        ec2 = Mock()
        ec2.describe_vpcs.return_value = {"Vpcs": [{"VpcId": config["ec2Context"]["vpcId"], "State": "available"}]}
        subnets, routes = [], []
        for index, (az, public) in enumerate([("a", True), ("b", True), ("a", False), ("b", False)], 1):
            subnet = "subnet-" + str(index).zfill(17)
            subnets.append({"SubnetId": subnet, "AvailabilityZone": "ap-northeast-2" + az,
                            "MapPublicIpOnLaunch": public})
            route = {"DestinationCidrBlock": "0.0.0.0/0", "State": "active"}
            route["GatewayId" if public else "NatGatewayId"] = "igw-owned" if public else "nat-owned"
            routes.append({"Associations": [{"SubnetId": subnet}], "Routes": [route]})
        ec2.describe_subnets.return_value = {"Subnets": subnets}
        ec2.describe_route_tables.return_value = {"RouteTables": routes}
        ec2.describe_nat_gateways.return_value = {"NatGateways": [
            {"State": "available", "VpcId": config["ec2Context"]["vpcId"]}]}
        ec2.describe_managed_prefix_lists.return_value = {"PrefixLists": [
            {"OwnerId": "AWS", "PrefixListId": "pl-00000000000000001"}]}
        result = discover_network(config, ec2)
        ec2.describe_vpcs.assert_called_once_with(VpcIds=[config["ec2Context"]["vpcId"]])
        self.assertEqual(result["network"]["vpcId"], config["ec2Context"]["vpcId"])

    def test_sts_account_mismatch_is_rejected_before_network_discovery(self):
        module = self.module()
        from lab_config import aws_session
        config = module.configuration_for_ec2("team01", self.context())
        session = Mock()
        session.client.return_value.get_caller_identity.return_value = {"Account": "999999999999"}
        with patch("boto3.Session", return_value=session):
            with self.assertRaises(ValueError):
                aws_session(config)

    def test_identity_only_init_checks_account_without_requiring_full_web_network(self):
        self.module()
        import lab
        with tempfile.TemporaryDirectory(prefix="atlas-identity-test-") as directory:
            output = Path(directory) / "team01.json"
            with patch.object(sys, "argv", ["lab.py", "init-ec2", "--identity-only",
                                           "--participant", "team01", "--config", str(output)]), \
                    patch("ec2_context.read_ec2_context", return_value=self.context()), \
                    patch("lab.aws_session") as session, patch("lab.discover_network") as discover, \
                    patch("lab.emit") as emit:
                lab.main()
            session.assert_called_once()
            discover.assert_not_called()
            config = json.loads(output.read_text())
            self.assertEqual(config["ec2Context"], self.context())
            self.assertEqual(config["network"], {})
            self.assertFalse(emit.call_args.args[0]["networkChecked"])
            self.assertFalse(emit.call_args.args[0]["createdAwsResources"])

    def test_identity_only_init_cannot_write_a_config_for_a_mismatched_account(self):
        self.module()
        import lab
        with tempfile.TemporaryDirectory(prefix="atlas-identity-test-") as directory:
            output = Path(directory) / "team01.json"
            with patch.object(sys, "argv", ["lab.py", "init-ec2", "--identity-only",
                                           "--participant", "team01", "--config", str(output)]), \
                    patch("ec2_context.read_ec2_context", return_value=self.context()), \
                    patch("lab.aws_session", side_effect=ValueError("AWS account mismatch")), \
                    patch("lab.discover_network") as discover:
                with self.assertRaisesRegex(ValueError, "account mismatch"):
                    lab.main()
            self.assertFalse(output.exists())
            discover.assert_not_called()

    def test_prepared_ec2_workspace_checks_vpc_identity_instead_of_name_tag(self):
        module = self.module()
        from lab_workspace import prepare_workspace
        config = module.configuration_for_ec2("team01", self.context())
        config["network"] = {
            "vpcId": self.context()["vpcId"],
            "publicSubnetIds": ["subnet-00000000000000001", "subnet-00000000000000002"],
            "privateSubnetIds": ["subnet-00000000000000003", "subnet-00000000000000004"],
            "cloudFrontPrefixListId": "pl-00000000000000001",
        }
        with tempfile.TemporaryDirectory(prefix="atlas-ec2-test-") as directory:
            workspace = prepare_workspace(config, ROOT, Path(directory))
            code = (workspace / "scripts/deploy.py").read_text()
            self.assertIn('vpc.get("VpcId") != VPC', code)
            self.assertNotIn("VPC name does not match", code)
            self.assertIn("Task subnet", code)
            self.assertIn("NatGatewayId", code)


if __name__ == "__main__":
    unittest.main()
