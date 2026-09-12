"""Exercise the CloudFormation request contract without modifying AWS."""
from copy import deepcopy
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import warnings

warnings.filterwarnings("ignore", category=DeprecationWarning)
import boto3
from botocore.stub import ANY, Stubber

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("jeju_deploy", root / "scripts/deploy.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
verify_spec = importlib.util.spec_from_file_location("jeju_verify", root / "scripts/verify.py")
verifier = importlib.util.module_from_spec(verify_spec)
with patch.dict(sys.modules, {"deploy": deploy}):
    verify_spec.loader.exec_module(verifier)


class ChangeSetPlanningTest(unittest.TestCase):
    def test_replan_of_unexecuted_stack_uses_create(self):
        """Using UPDATE for REVIEW_IN_PROGRESS must fail the API contract."""
        cf = boto3.client(
            "cloudformation", region_name="ap-northeast-2",
            aws_access_key_id="test-key", aws_secret_access_key="test-secret",
        )
        arn = "arn:aws:cloudformation:ap-northeast-2:061525506239:changeSet/test/id"
        stubber = Stubber(cf)
        stubber.add_response("describe_stacks", {
            "Stacks": [{
                "StackName": "Jeju3dRegistry",
                "CreationTime": datetime(2026, 9, 9, tzinfo=timezone.utc),
                "StackStatus": "REVIEW_IN_PROGRESS",
            }],
        }, {"StackName": "Jeju3dRegistry"})
        stubber.add_response("create_change_set", {"Id": arn}, {
            "StackName": "Jeju3dRegistry",
            "ChangeSetName": ANY,
            "ChangeSetType": "CREATE",
            "Description": ANY,
            "TemplateBody": ANY,
            "Parameters": [],
            "Capabilities": ["CAPABILITY_IAM"],
            "Tags": ANY,
        })
        stubber.add_response("describe_change_set", {
            "Status": "CREATE_COMPLETE",
            "Changes": [{
                "Type": "Resource",
                "ResourceChange": {
                    "Action": "Add", "LogicalResourceId": "Repository",
                    "ResourceType": "AWS::ECR::Repository",
                },
            }],
        }, {"ChangeSetName": arn})

        class Session:
            def client(self, service):
                if service != "cloudformation":
                    raise AssertionError(f"Unexpected service: {service}")
                return cf

        with tempfile.TemporaryDirectory(prefix="jeju-plan-test-") as temp:
            with patch.object(deploy, "LOCAL", Path(temp)), stubber:
                deploy.plan(Session(), "bootstrap")
                result = json.loads((Path(temp) / "bootstrap-change-set.json").read_text())
                self.assertEqual(result["type"], "CREATE")
                self.assertEqual(result["changes"][0]["Action"], "Add")
                stubber.assert_no_pending_responses()


class ProductionSettingsTest(unittest.TestCase):
    def config(self, **changes):
        values = {
            "ViewerDomainName": "jeju-atlas.whchoi.net",
            "ViewerCertificateArn": "arn:aws:acm:us-east-1:061525506239:certificate/7d53182a-2a2a-4225-a319-4f94030561b7",
            "DesiredCount": 2,
        }
        values.update(changes)
        return values

    def test_current_domain_and_certificate_are_explicit_deployment_parameters(self):
        settings = deploy.validate_settings(self.config())
        self.assertEqual(settings["ViewerDomainName"], "jeju-atlas.whchoi.net")
        self.assertEqual(settings["DesiredCount"], "2")
        self.assertIn(":us-east-1:", settings["ViewerCertificateArn"])

    def test_disabling_ai_limits_is_an_explicit_boolean_setting(self):
        self.assertEqual(deploy.validate_settings(self.config())["GuideLimitsEnabled"], "true")
        self.assertEqual(deploy.validate_settings(self.config(GuideLimitsEnabled="false"))["GuideLimitsEnabled"], "false")
        for value in (False, True, 0, None, "off", "False"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                deploy.validate_settings(self.config(GuideLimitsEnabled=value))

    def test_incomplete_or_wrong_region_certificate_is_rejected_before_aws(self):
        for changes in [
            {"ViewerCertificateArn": ""},
            {"ViewerDomainName": ""},
            {"ViewerCertificateArn": self.config()["ViewerCertificateArn"].replace("us-east-1", "ap-northeast-2")},
            {"ViewerCertificateArn": self.config()["ViewerCertificateArn"].replace("061525506239", "111111111111")},
            {"ViewerDomainName": "https://jeju-atlas.whchoi.net/path"},
            {"DesiredCount": True},
            {"DesiredCount": 0},
            {"DesiredCount": 5},
            {"DesiredCount": 1},
            {"GuideDailyLimit": 31},
            {"GuideHourlyLimit": 6},
            {"GuideGlobalConcurrency": 3},
            {"MinTaskCount": 4, "MaxTaskCount": 2},
            {"OriginTlsEnabled": True},
            {"OriginTlsEnabled": "true"},
            {"OriginTlsEnabled": "true", "OriginDomainName": "jeju-atlas.whchoi.net"},
            {"TargetHealthPath": "/unknown"},
            {"SessionSecret": "must-not-be-a-deploy-setting"},
        ]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                deploy.validate_settings(self.config(**changes))

    def test_live_domain_cannot_silently_disappear_on_redeployment(self):
        live = {
            "Aliases": {"Items": ["jeju-atlas.whchoi.net"], "Quantity": 1},
            "ViewerCertificate": {"ACMCertificateArn": self.config()["ViewerCertificateArn"]},
        }
        deploy.validate_live_domain(self.config(), live)
        with self.assertRaises(ValueError):
            deploy.validate_live_domain(self.config(ViewerDomainName=""), live)
        with self.assertRaises(ValueError):
            deploy.validate_live_domain(self.config(ViewerDomainName="different.whchoi.net"), live)
        with self.assertRaises(ValueError):
            deploy.validate_live_domain(self.config(), {
                **live, "Aliases": {"Items": ["jeju-atlas.whchoi.net", "another.whchoi.net"]},
            })

    def test_existing_autoscaled_capacity_is_not_reset_to_minimum(self):
        self.assertEqual(deploy.preserved_desired_count(2, 4, 4), "4")
        self.assertEqual(deploy.preserved_desired_count(2, 1, 4), "2")
        with self.assertRaises(ValueError):
            deploy.preserved_desired_count(2, 5, 4)

    def test_readiness_migration_cannot_make_legacy_targets_unhealthy_during_rollout(self):
        deploy.validate_readiness_transition("/healthz", "/healthz", False, False)
        deploy.validate_readiness_transition("/healthz", "/readyz", True, True)
        deploy.validate_readiness_transition("/readyz", "/readyz", True, False)
        for supported, stable in ((False, True), (True, False), (False, False)):
            with self.subTest(supported=supported, stable=stable), self.assertRaises(ValueError):
                deploy.validate_readiness_transition("/healthz", "/readyz", supported, stable)


class DetailsVerificationTest(unittest.TestCase):
    def setUp(self):
        self.environment = {
            "CATALOG_BUCKET": "catalog-test",
            "GUIDE_RUNTIME_ARN": "arn:aws:bedrock-agentcore:ap-northeast-2:061525506239:runtime/test",
            "GUIDE_QUOTA_TABLE": "quota-test",
        }
        self.parameters = {
            "DetailsBucket": "details-test",
            "MediaBucketDomainName": "details-test.s3.ap-northeast-2.amazonaws.com",
            "MediaOriginAccessControlId": "OAC-TEST",
        }
        self.statements = [
            {"Effect": "Allow", "Action": "s3:GetObject",
             "Resource": "arn:aws:s3:::catalog-test/catalog/catalog.sqlite"},
            {"Effect": "Allow", "Action": ["bedrock-agentcore:InvokeAgentRuntime",
                                         "bedrock-agentcore:InvokeAgentRuntimeForUser"],
             "Resource": ["arn:aws:bedrock-agentcore:ap-northeast-2:061525506239:runtime/test",
                          "arn:aws:bedrock-agentcore:ap-northeast-2:061525506239:runtime/test/runtime-endpoint/DEFAULT"]},
            {"Effect": "Allow", "Action": ["dynamodb:GetItem", "dynamodb:UpdateItem"],
             "Resource": "arn:aws:dynamodb:ap-northeast-2:061525506239:table/quota-test"},
        ]
        self.details_statement = {
            "Effect": "Allow", "Action": "s3:GetObject",
            "Resource": "arn:aws:s3:::details-test/place-details/latest.json",
        }
        self.origin = {
            "Id": "jeju-media", "DomainName": "details-test.s3.ap-northeast-2.amazonaws.com",
            "OriginAccessControlId": "OAC-TEST", "S3OriginConfig": {"OriginAccessIdentity": ""},
            "OriginPath": "", "CustomHeaders": {"Quantity": 0},
        }
        self.behavior = {
            "PathPattern": "/media/*", "TargetOriginId": "jeju-media",
            "ViewerProtocolPolicy": "redirect-to-https", "Compress": False,
            "AllowedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"],
                               "CachedMethods": {"Quantity": 2, "Items": ["GET", "HEAD"]}},
            "CachePolicyId": "media-cache",
        }
        self.oac = {
            "Name": "media-test", "OriginAccessControlOriginType": "s3",
            "SigningBehavior": "always", "SigningProtocol": "sigv4",
        }
        self.cache = {
            "Name": "media-test", "MinTTL": 0, "DefaultTTL": 31536000, "MaxTTL": 31536000,
            "ParametersInCacheKeyAndForwardedToOrigin": {
                "EnableAcceptEncodingGzip": False, "EnableAcceptEncodingBrotli": False,
                "CookiesConfig": {"CookieBehavior": "none"},
                "HeadersConfig": {"HeaderBehavior": "none"},
                "QueryStringsConfig": {"QueryStringBehavior": "none"},
            },
        }

    def iam_result(self, statements, environment=None, details_bucket="", attached=None):
        def checked(value):
            def response(**kwargs):
                self.assertEqual(kwargs["RoleName"], "task-test")
                return deepcopy(value)
            return response
        iam = SimpleNamespace(
            list_attached_role_policies=checked({"AttachedPolicies": attached or []}),
            list_role_policies=checked({"PolicyNames": ["task-policy"]}),
            get_role_policy=checked({"PolicyDocument": {"Statement": statements}}),
        )
        return verifier.task_iam_scoped(
            iam, "task-test", environment or self.environment, details_bucket=details_bucket,
        )

    def test_presence_access_is_required_only_on_the_selected_presence_table(self):
        environment = {**self.environment, "PRESENCE_TABLE": "presence-test"}
        presence = {
            "Effect": "Allow",
            "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
                       "dynamodb:Query", "dynamodb:ConditionCheckItem"],
            "Resource": "arn:aws:dynamodb:ap-northeast-2:061525506239:table/presence-test",
        }
        self.assertTrue(self.iam_result([*self.statements, presence], environment=environment))
        self.assertFalse(self.iam_result(self.statements, environment=environment))
        for resource in ("*", "arn:aws:dynamodb:ap-northeast-2:061525506239:table/quota-test"):
            with self.subTest(resource=resource):
                self.assertFalse(self.iam_result(
                    [*self.statements, {**presence, "Resource": resource}], environment=environment,
                ))
        self.assertFalse(self.iam_result(
            [*self.statements, {**presence, "Action": [*presence["Action"], "dynamodb:Scan"]}],
            environment=environment,
        ))

    def media_result(self, *, origin=None, behavior=None, parameters=None, oac=None, cache=None,
                     extra_behavior=None, default_origin="jeju-alb"):
        origin = deepcopy(self.origin if origin is None else origin)
        behavior = deepcopy(self.behavior if behavior is None else behavior)
        parameters = self.parameters if parameters is None else parameters
        config = {
            "Origins": {"Items": [origin] if origin else []},
            "DefaultCacheBehavior": {"TargetOriginId": default_origin},
            "CacheBehaviors": {"Items": ([behavior] if behavior else []) + ([extra_behavior] if extra_behavior else [])},
        }
        results = {}

        def read_oac(**kwargs):
            self.assertEqual(kwargs, {"Id": "OAC-TEST"})
            self.assertTrue(parameters.get("DetailsBucket"), "No details must not query optional resources")
            return {"OriginAccessControl": {"Id": "OAC-TEST", "OriginAccessControlConfig": oac or self.oac}}

        def read_cache(**kwargs):
            self.assertEqual(kwargs, {"Id": "media-cache"})
            self.assertTrue(parameters.get("DetailsBucket"), "No details must not query optional resources")
            return {"CachePolicy": {"CachePolicyConfig": cache or self.cache}}

        edge = SimpleNamespace(get_origin_access_control=read_oac, get_cache_policy=read_cache)
        verifier.verify_media_delivery(edge, config, parameters, lambda name, passed: results.update({name: bool(passed)}))
        self.assertTrue(results, "The media verification cannot silently skip all checks")
        return results

    def test_optional_details_require_both_exact_snapshot_and_catalog_getobject(self):
        environment = {**self.environment, "DETAILS_BUCKET": "details-test", "DETAILS_KEY": "place-details/latest.json"}
        statements = [*self.statements, self.details_statement]
        self.assertTrue(self.iam_result(statements, environment, "details-test"))
        for index in (0, 3):
            with self.subTest(missing=index):
                self.assertFalse(self.iam_result(statements[:index] + statements[index + 1:], environment, "details-test"))

    def test_no_details_keeps_catalog_model_quota_scoping_and_rejects_added_access(self):
        self.assertTrue(self.iam_result(self.statements))
        for statement in [
            self.details_statement,
            {"Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::catalog-test/*"},
            {"Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::other/catalog/catalog.sqlite"},
            {"Effect": "Allow", "Action": "ssm:GetParameters", "Resource": "*"},
            {"Effect": "Allow", "Action": "bedrock:InvokeModel", "Resource": "*"},
            {"Effect": "Allow", "Action": "dynamodb:DeleteItem", "Resource": "*"},
        ]:
            with self.subTest(action=statement["Action"], resource=statement["Resource"]):
                self.assertFalse(self.iam_result([*self.statements, statement]))
        for index in (1, 2):
            with self.subTest(missing=index):
                self.assertFalse(self.iam_result(self.statements[:index] + self.statements[index + 1:]))
        self.assertFalse(self.iam_result(self.statements, attached=[{"PolicyArn": "arn:aws:iam::aws:policy/ReadOnlyAccess"}]))

    def test_details_environment_and_permission_cannot_drift_from_stack(self):
        environment = {**self.environment, "DETAILS_BUCKET": "details-test", "DETAILS_KEY": "place-details/latest.json"}
        statements = [*self.statements, self.details_statement]
        for changes, bucket in [
            ({}, ""), ({"DETAILS_BUCKET": "other"}, "details-test"),
            ({"DETAILS_BUCKET": ""}, "details-test"), ({"DETAILS_KEY": "place-details/*"}, "details-test"),
            ({"DETAILS_KEY": ""}, "details-test"),
        ]:
            with self.subTest(changes=changes, bucket=bucket):
                self.assertFalse(self.iam_result(statements, {**environment, **changes}, bucket))
        for resource in ["arn:aws:s3:::details-test/*", "arn:aws:s3:::details-test/media/*"]:
            with self.subTest(resource=resource):
                self.assertFalse(self.iam_result(
                    [*self.statements, {**self.details_statement, "Resource": resource}], environment, "details-test",
                ))

    def test_media_accepts_signed_s3_and_shared_one_year_cache(self):
        self.assertTrue(all(self.media_result().values()))

    def test_no_details_requires_no_media_origin_or_route(self):
        self.assertTrue(all(self.media_result(origin={}, behavior={}, parameters={}).values()))
        for origin, behavior in [(self.origin, {}), ({}, self.behavior), (self.origin, self.behavior)]:
            with self.subTest(origin=bool(origin), behavior=bool(behavior)):
                self.assertFalse(all(self.media_result(origin=origin, behavior=behavior, parameters={}).values()))

    def test_media_rejects_origin_route_and_request_forwarding_drift(self):
        for changes in [
            {"DomainName": "other.s3.ap-northeast-2.amazonaws.com"},
            {"S3OriginConfig": {"OriginAccessIdentity": "origin-access-identity/cloudfront/legacy"}},
            {"CustomOriginConfig": {"OriginProtocolPolicy": "http-only"}},
            {"OriginPath": "/place-details"},
            {"OriginAccessControlId": ""}, {"OriginAccessControlId": "OTHER"},
            {"CustomHeaders": {"Quantity": 1, "Items": [{"HeaderName": "X-Jeju-Origin-Verify", "HeaderValue": "test-only"}]}},
        ]:
            with self.subTest(origin_change=changes):
                self.assertFalse(all(self.media_result(origin={**self.origin, **changes}).values()))
        for changes in [
            {"TargetOriginId": "jeju-alb"}, {"ViewerProtocolPolicy": "allow-all"},
            {"PathPattern": "/place-details/*"}, {"OriginRequestPolicyId": "private-api"},
            {"AllowedMethods": {**self.behavior["AllowedMethods"], "Quantity": 3, "Items": ["GET", "HEAD", "POST"]}},
            {"Compress": True}, {"CachePolicyId": ""},
        ]:
            with self.subTest(behavior_change=changes):
                self.assertFalse(all(self.media_result(behavior={**self.behavior, **changes}).values()))
        self.assertFalse(all(self.media_result(default_origin="jeju-media").values()))
        self.assertFalse(all(self.media_result(extra_behavior={
            **self.behavior, "PathPattern": "/place-details/*",
        }).values()))

    def test_media_rejects_unsigned_origins_and_viewer_specific_or_wrong_ttl_caches(self):
        for changes in [
            {"SigningBehavior": "never"}, {"SigningBehavior": "no-override"},
            {"SigningProtocol": "sigv4a"}, {"OriginAccessControlOriginType": "lambda"},
        ]:
            with self.subTest(oac_change=changes):
                self.assertFalse(all(self.media_result(oac={**self.oac, **changes}).values()))
        for changes in [{"MinTTL": 1}, {"DefaultTTL": 86400}, {"MaxTTL": 63072000}]:
            with self.subTest(cache_change=changes):
                self.assertFalse(all(self.media_result(cache={**self.cache, **changes}).values()))
        for changes in [
            {"CookiesConfig": {"CookieBehavior": "all"}},
            {"HeadersConfig": {"HeaderBehavior": "whitelist", "Headers": {"Items": ["Origin"]}}},
            {"QueryStringsConfig": {"QueryStringBehavior": "all"}}, {"EnableAcceptEncodingGzip": True},
        ]:
            with self.subTest(forwarding_change=changes):
                cache = deepcopy(self.cache)
                cache["ParametersInCacheKeyAndForwardedToOrigin"].update(changes)
                self.assertFalse(all(self.media_result(cache=cache).values()))


if __name__ == "__main__":
    unittest.main()
