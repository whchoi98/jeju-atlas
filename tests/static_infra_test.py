"""Private immutable asset storage contracts; no AWS calls."""
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
        value = loader.construct_sequence(node)
    else:
        value = loader.construct_mapping(node)
    return {tag: value}


Loader.add_multi_constructor("!", intrinsic)


class StaticInfrastructureTest(unittest.TestCase):
    def setUp(self):
        path = ROOT / "infra/static.yaml"
        self.assertTrue(path.is_file(), "Static assets stack is not implemented")
        self.template = yaml.load(path.read_text(), Loader=Loader)
        self.resources = self.template["Resources"]

    def test_bucket_is_private_encrypted_versioned_and_retained_without_expiration(self):
        bucket = self.resources["AssetsBucket"]
        self.assertEqual(bucket["DeletionPolicy"], "Retain")
        self.assertEqual(bucket["UpdateReplacePolicy"], "Retain")
        properties = bucket["Properties"]
        self.assertEqual(properties["BucketName"], {"Sub": "jeju-3d-assets-${AWS::AccountId}-${AWS::Region}"})
        self.assertTrue(all(properties["PublicAccessBlockConfiguration"].values()))
        self.assertEqual(properties["VersioningConfiguration"]["Status"], "Enabled")
        self.assertEqual(properties["OwnershipControls"]["Rules"][0]["ObjectOwnership"], "BucketOwnerEnforced")
        self.assertNotIn("LifecycleConfiguration", properties)
        self.assertEqual(properties["BucketEncryption"]["ServerSideEncryptionConfiguration"][0]
                         ["ServerSideEncryptionByDefault"]["SSEAlgorithm"], "AES256")

    def test_cloudfront_can_read_assets_only_and_all_plain_http_is_denied(self):
        statements = self.resources["AssetsBucketPolicy"]["Properties"]["PolicyDocument"]["Statement"]
        allow = [item for item in statements if item["Effect"] == "Allow"]
        self.assertEqual(len(allow), 1)
        self.assertEqual(allow[0]["Principal"], {"Service": "cloudfront.amazonaws.com"})
        self.assertEqual(allow[0]["Action"], "s3:GetObject")
        self.assertEqual(allow[0]["Resource"], {"Sub": "${AssetsBucket.Arn}/assets/*"})
        self.assertEqual(allow[0]["Condition"]["StringEquals"]["AWS:SourceArn"], {"Ref": "DistributionArn"})
        deny = [item for item in statements if item["Effect"] == "Deny"]
        self.assertTrue(any(item["Action"] == "s3:*"
                            and str(item["Condition"]["Bool"]["aws:SecureTransport"]).lower() == "false"
                            for item in deny))

    def test_oac_and_outputs_match_parent_without_owning_compute_or_shared_networks(self):
        self.assertEqual({item["Type"] for item in self.resources.values()},
                         {"AWS::S3::Bucket", "AWS::S3::BucketPolicy", "AWS::CloudFront::OriginAccessControl"})
        config = self.resources["AssetsOriginAccessControl"]["Properties"]["OriginAccessControlConfig"]
        self.assertEqual((config["OriginAccessControlOriginType"], config["SigningBehavior"], config["SigningProtocol"]),
                         ("s3", "always", "sigv4"))
        self.assertEqual(self.template["Outputs"]["AssetsBucketName"]["Value"], {"Ref": "AssetsBucket"})
        self.assertEqual(self.template["Outputs"]["AssetsBucketDomainName"]["Value"],
                         {"GetAtt": "AssetsBucket.RegionalDomainName"})
        self.assertEqual(self.template["Outputs"]["AssetsOriginAccessControlId"]["Value"], {"Ref": "AssetsOriginAccessControl"})


if __name__ == "__main__":
    unittest.main()
