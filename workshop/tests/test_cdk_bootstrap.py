"""Bootstrap preflight is read-only, account-bound, and fails closed offline."""
from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "workshop/scripts/cdk_bootstrap.py"
ACCOUNT = "123456789012"
PARAMETER = "/cdk-bootstrap/hnb659fds/version"
SECRET = "credential-process-secret-MUST-NOT-LEAK"


class ServiceError(Exception):
    """SDK-shaped error without requiring boto3 in the injected-client tests."""

    def __init__(self, code, message=SECRET):
        super().__init__(message)
        self.response = {
            "Error": {"Code": code, "Message": message},
            "ResponseMetadata": {"HTTPStatusCode": 400},
        }


def stack_response(version="30", status="CREATE_COMPLETE"):
    return {"Stacks": [{
        "StackName": "CDKToolkit",
        "StackId": "arn:aws:cloudformation:ap-northeast-2:123456789012:stack/CDKToolkit/test",
        "StackStatus": status,
        "StackStatusReason": SECRET,
        "Outputs": [
            {"OutputKey": "BootstrapVersion", "OutputValue": version},
            {"OutputKey": "UnrelatedOutput", "OutputValue": SECRET},
        ],
    }]}


def parameter_response(version="30"):
    return {"Parameter": {
        "Name": PARAMETER, "Type": "String", "Value": version,
        # SSM's revision number is unrelated to the bootstrap version in Value.
        "Version": 1,
        "ARN": "arn:aws:ssm:ap-northeast-2:123456789012:parameter" + PARAMETER,
    }}


def missing_stack():
    return ServiceError("ValidationError", "Stack with id CDKToolkit does not exist")


class Cloud:
    """Only the three permitted read operations exist at this AWS boundary."""

    def __init__(self):
        self.responses = {
            "sts": {"Account": ACCOUNT, "Arn": SECRET, "UserId": SECRET},
            "cloudformation": stack_response(),
            "ssm": parameter_response(),
        }
        self.calls = []
        self.factories = []
        self.factory_errors = {}

    def client(self, service):
        self.factories.append(service)
        if service in self.factory_errors:
            raise self.factory_errors[service]
        cloud = self

        class Client:
            def get_caller_identity(self):
                return cloud.respond(service, "get_caller_identity", {})

            def describe_stacks(self, **kwargs):
                return cloud.respond(service, "describe_stacks", kwargs)

            def get_parameter(self, **kwargs):
                return cloud.respond(service, "get_parameter", kwargs)

        return Client()

    def respond(self, service, operation, kwargs):
        self.calls.append((service, operation, kwargs))
        response = self.responses[service]
        if isinstance(response, Exception):
            raise response
        return deepcopy(response)


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), "The read-only bootstrap checker is missing")
        spec = importlib.util.spec_from_file_location("workshop_cdk_bootstrap_test", SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.cloud = Cloud()

    def check(self, **kwargs):
        result = self.module.check(client_factory=self.cloud.client, **kwargs)
        self.assertNotIn(SECRET, json.dumps(result))
        return result

    def cli(self, args=(), env=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, env or {}, clear=True), \
                redirect_stdout(stdout), redirect_stderr(stderr):
            code = self.module.main(list(args), client_factory=self.cloud.client)
        self.assertEqual(stderr.getvalue(), "")
        self.assertNotIn(SECRET, stdout.getvalue())
        result = json.loads(stdout.getvalue())
        return code, result

    def test_both_absent_is_missing_with_only_exact_read_operations(self):
        self.cloud.responses.update(cloudformation=missing_stack(),
                                    ssm=ServiceError("ParameterNotFound"))
        result = self.check()
        self.assertEqual(result["status"], "missing")
        self.assertFalse(result["ready"])
        self.assertEqual(result["account"], ACCOUNT)
        self.assertEqual(result["region"], "ap-northeast-2")
        self.assertEqual(result["stack"], "CDKToolkit")
        self.assertEqual(result["parameter"], PARAMETER)
        self.assertEqual(result["minimumVersion"], 30)
        self.assertIsNone(result["stackVersion"])
        self.assertIsNone(result["ssmVersion"])
        self.assertFalse(result["stackExists"])
        self.assertFalse(result["parameterExists"])
        self.assertEqual(self.cloud.factories, ["sts", "cloudformation", "ssm"])
        self.assertEqual(self.cloud.calls, [
            ("sts", "get_caller_identity", {}),
            ("cloudformation", "describe_stacks", {"StackName": "CDKToolkit"}),
            ("ssm", "get_parameter", {"Name": PARAMETER, "WithDecryption": False}),
        ])

    def test_version_30_and_newer_need_matching_values_and_a_ready_stack(self):
        for status in ("CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"):
            for version in ("30", "31", "100"):
                with self.subTest(status=status, version=version):
                    self.cloud.responses.update(
                        cloudformation=stack_response(version, status),
                        ssm=parameter_response(version),
                    )
                    result = self.check()
                    self.assertEqual(result["status"], "ready")
                    self.assertTrue(result["ready"])
                    self.assertEqual(result["stackStatus"], status)
                    self.assertEqual(result["stackVersion"], int(version))
                    self.assertEqual(result["ssmVersion"], int(version))
                    self.assertTrue(result["stackExists"])
                    self.assertTrue(result["parameterExists"])

    def test_versions_are_compared_numerically_instead_of_as_strings(self):
        self.cloud.responses["cloudformation"] = stack_response("030")
        result = self.check()
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["stackVersion"], 30)

    def test_version_29_and_older_are_outdated(self):
        for version in ("0", "1", "29"):
            with self.subTest(version=version):
                self.cloud.responses.update(
                    cloudformation=stack_response(version), ssm=parameter_response(version),
                )
                result = self.check()
                self.assertEqual(result["status"], "outdated")
                self.assertFalse(result["ready"])
                self.assertEqual(result["stackVersion"], int(version))
                self.assertEqual(result["ssmVersion"], int(version))

    def test_one_absent_resource_is_inconsistent(self):
        for service, absent in (("cloudformation", missing_stack()),
                                ("ssm", ServiceError("ParameterNotFound"))):
            with self.subTest(service=service):
                self.cloud = Cloud()
                self.cloud.responses[service] = absent
                result = self.check()
                self.assertEqual(result["status"], "inconsistent")
                self.assertFalse(result["ready"])
                self.assertEqual(result["stackExists"], service != "cloudformation")
                self.assertEqual(result["parameterExists"], service != "ssm")

    def test_version_disagreement_is_inconsistent_even_if_one_is_outdated(self):
        for stack, parameter in (("30", "31"), ("31", "30"), ("29", "30")):
            with self.subTest(stack=stack, parameter=parameter):
                self.cloud.responses.update(
                    cloudformation=stack_response(stack), ssm=parameter_response(parameter),
                )
                result = self.check()
                self.assertEqual(result["status"], "inconsistent")
                self.assertFalse(result["ready"])

    def test_in_progress_failed_and_rolled_back_stacks_are_not_ready(self):
        for status in ("CREATE_IN_PROGRESS", "UPDATE_IN_PROGRESS",
                       "UPDATE_ROLLBACK_IN_PROGRESS", "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS",
                       "CREATE_FAILED", "ROLLBACK_COMPLETE", "DELETE_COMPLETE",
                       "REVIEW_IN_PROGRESS"):
            with self.subTest(status=status):
                self.cloud.responses["cloudformation"] = stack_response(status=status)
                result = self.check()
                self.assertEqual(result["status"], "not_ready")
                self.assertEqual(result["stackStatus"], status)
                self.assertFalse(result["ready"])

    def test_creating_stack_can_lack_outputs_without_being_called_missing(self):
        response = stack_response(status="CREATE_IN_PROGRESS")
        del response["Stacks"][0]["Outputs"]
        self.cloud.responses["cloudformation"] = response
        result = self.check()
        self.assertEqual(result["status"], "not_ready")
        self.assertTrue(result["stackExists"])
        self.assertIsNone(result["stackVersion"])
        self.assertFalse(result["ready"])

    def test_creating_stack_with_no_parameter_waits_instead_of_reporting_inconsistency(self):
        response = stack_response(status="CREATE_IN_PROGRESS")
        del response["Stacks"][0]["Outputs"]
        self.cloud.responses.update(
            cloudformation=response, ssm=ServiceError("ParameterNotFound"),
        )
        result = self.check()
        self.assertEqual(result["status"], "not_ready")
        self.assertFalse(result["ready"])
        code, result = self.cli(("--require-missing",))
        self.assertEqual(code, 1)
        self.assertEqual(result["status"], "not_ready")

    def test_unrelated_validation_errors_are_never_absence(self):
        for message in (
                SECRET,
                "Stack with id AnotherStack does not exist",
                "Stack with id CDKToolkit-other does not exist",
                "Stack with id cdktoolkit does not exist",
                "Stack with id CDKToolkit does not exist\n" + SECRET,
                SECRET + " Stack with id CDKToolkit does not exist",
                "CDKToolkit has an invalid parameter"):
            with self.subTest(message=message):
                self.cloud.responses.update(
                    cloudformation=ServiceError("ValidationError", message),
                    ssm=ServiceError("ParameterNotFound"),
                )
                result = self.check()
                self.assertEqual(result["status"], "error")
                self.assertFalse(result["ready"])
                self.assertIsNone(result["stackExists"])

    def test_absence_wording_does_not_override_access_denied(self):
        self.cloud.responses.update(
            cloudformation=ServiceError(
                "AccessDenied", "Stack with id CDKToolkit does not exist"),
            ssm=ServiceError("ParameterNotFound"),
        )
        self.assertEqual(self.check()["status"], "access_denied")

    def test_access_denied_is_distinct_and_never_prints_service_messages(self):
        for service in ("sts", "cloudformation", "ssm"):
            for code in ("AccessDenied", "AccessDeniedException", "UnauthorizedOperation"):
                with self.subTest(service=service, code=code):
                    self.cloud = Cloud()
                    self.cloud.responses[service] = ServiceError(code)
                    result = self.check()
                    self.assertEqual(result["status"], "access_denied")
                    self.assertEqual(result["error"]["service"], service)
                    self.assertFalse(result["ready"])

    def test_timeout_and_connection_errors_are_not_missing(self):
        for service in ("sts", "cloudformation", "ssm"):
            for error in (TimeoutError(SECRET), ConnectionError(SECRET)):
                with self.subTest(service=service, error=type(error).__name__):
                    self.cloud = Cloud()
                    self.cloud.responses[service] = error
                    result = self.check()
                    self.assertEqual(result["status"], "network_error")
                    self.assertEqual(result["error"]["service"], service)
                    self.assertFalse(result["ready"])

    def test_botocore_network_and_credential_errors_are_masked(self):
        from botocore.exceptions import (
            ConnectTimeoutError, CredentialRetrievalError, EndpointConnectionError,
            NoCredentialsError, ReadTimeoutError,
        )
        cases = [
            (ConnectTimeoutError(endpoint_url=SECRET), "network_error"),
            (ReadTimeoutError(endpoint_url=SECRET), "network_error"),
            (EndpointConnectionError(endpoint_url=SECRET), "network_error"),
            (CredentialRetrievalError(provider="custom-process", error_msg=SECRET),
             "credentials_error"),
            (NoCredentialsError(), "credentials_error"),
            (ServiceError("ExpiredToken"), "credentials_error"),
        ]
        for error, status in cases:
            with self.subTest(error=type(error).__name__):
                self.cloud = Cloud()
                self.cloud.responses["sts"] = error
                result = self.check()
                self.assertEqual(result["status"], status)
                self.assertFalse(result["ready"])
                self.assertEqual(self.cloud.factories, ["sts"])

    def test_factory_errors_are_caught_before_raw_credential_output_can_escape(self):
        for service in ("sts", "cloudformation", "ssm"):
            with self.subTest(service=service):
                self.cloud = Cloud()
                self.cloud.factory_errors[service] = RuntimeError(SECRET)
                code, result = self.cli()
                self.assertEqual(code, 1)
                self.assertEqual(result["status"], "error")
                self.assertEqual(result["error"]["service"], service)
                self.assertFalse(result["ready"])

    def test_unknown_or_malformed_error_metadata_is_not_echoed(self):
        errors = [ServiceError(SECRET), ServiceError("ValidationError", None)]
        for metadata in (None, [], {"Error": None}, {"Error": []},
                         {"Error": {"Code": [SECRET], "Message": SECRET}}):
            error = RuntimeError(SECRET)
            error.response = metadata
            errors.append(error)
        for error in errors:
            with self.subTest(error=type(error).__name__):
                self.cloud.responses["cloudformation"] = error
                self.assertEqual(self.check()["status"], "error")

    def test_wrong_sts_account_stops_before_cfn_and_ssm_client_creation(self):
        result = self.check(expected_account="999999999999")
        self.assertEqual(result["status"], "account_mismatch")
        self.assertEqual(result["account"], ACCOUNT)
        self.assertEqual(result["expectedAccount"], "999999999999")
        self.assertFalse(result["ready"])
        self.assertIsNone(result["stackExists"])
        self.assertIsNone(result["parameterExists"])
        self.assertEqual(self.cloud.factories, ["sts"])
        self.assertEqual(self.cloud.calls, [("sts", "get_caller_identity", {})])

    def test_malformed_sts_account_stops_before_resource_probes(self):
        for account in (None, "", "000000000000", "12345678901", "1234567890123",
                        123456789012, True, [], "１２３４５６７８９０１２",
                        " 123456789012", "123456789012\n", SECRET):
            with self.subTest(account=account):
                self.cloud = Cloud()
                self.cloud.responses["sts"]["Account"] = account
                result = self.check()
                self.assertEqual(result["status"], "invalid_metadata")
                self.assertIsNone(result["account"])
                self.assertFalse(result["ready"])
                self.assertEqual(self.cloud.factories, ["sts"])

    def test_malformed_identity_response_is_not_an_account_or_bootstrap(self):
        for response in (None, [], {}, {"Arn": SECRET}):
            with self.subTest(response=response):
                self.cloud = Cloud()
                self.cloud.responses["sts"] = response
                result = self.check()
                self.assertEqual(result["status"], "invalid_metadata")
                self.assertEqual(self.cloud.factories, ["sts"])

    def test_nonzero_account_can_contain_zeroes_and_preserves_leading_zeroes(self):
        self.cloud.responses["sts"]["Account"] = "000000000001"
        result = self.check(expected_account="000000000001")
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["account"], "000000000001")

    def test_invalid_expected_account_does_not_construct_any_client(self):
        for account in ("", "000000000000", "123", 123456789012, [],
                        "１２３４５６７８９０１２", "123456789012\n", SECRET):
            with self.subTest(account=account):
                self.cloud = Cloud()
                result = self.check(expected_account=account)
                self.assertEqual(result["status"], "invalid_input")
                self.assertIsNone(result["expectedAccount"])
                self.assertFalse(result["ready"])
                self.assertEqual(self.cloud.factories, [])

    def test_other_regions_are_rejected_before_client_creation(self):
        for region in ("us-east-1", "", None, SECRET):
            with self.subTest(region=region):
                self.cloud = Cloud()
                result = self.check(region=region)
                self.assertEqual(result["status"], "invalid_input")
                self.assertFalse(result["ready"])
                self.assertEqual(self.cloud.factories, [])

    def test_malformed_stack_response_fails_closed_without_echoing_fields(self):
        malformed = [None, [], {}, {"Stacks": []}, {"Stacks": [None]},
                     {"Stacks": stack_response()["Stacks"] * 2}]
        for field, value in (
                ("StackName", SECRET), ("StackStatus", SECRET), ("StackStatus", []),
                ("Outputs", None), ("Outputs", {}), ("Outputs", [None]),
                ("Outputs", []),
                ("Outputs", [{"OutputKey": "Other", "OutputValue": "30"}]),
                ("Outputs", [{"OutputKey": "BootstrapVersion", "OutputValue": "30"}] * 2)):
            response = stack_response()
            response["Stacks"][0][field] = value
            malformed.append(response)
        for response in malformed:
            with self.subTest(response=response):
                self.cloud.responses["cloudformation"] = response
                result = self.check()
                self.assertEqual(result["status"], "invalid_metadata")
                self.assertFalse(result["ready"])

    def test_malformed_parameter_response_fails_closed_without_echoing_fields(self):
        malformed = [None, [], {}, {"Parameter": None}, {"Parameter": []}]
        for field, value in (("Name", SECRET), ("Type", "SecureString"),
                             ("Type", None), ("Value", None)):
            response = parameter_response()
            response["Parameter"][field] = value
            malformed.append(response)
        for response in malformed:
            with self.subTest(response=response):
                self.cloud.responses["ssm"] = response
                result = self.check()
                self.assertEqual(result["status"], "invalid_metadata")
                self.assertFalse(result["ready"])

    def test_bootstrap_versions_must_be_unsigned_ascii_integer_strings(self):
        for value in (None, "", " ", "30\n", " 30", "30.0", "+30", "-30",
                      "3e1", "３０", "v30", 30, 30.0, True, [], {}, SECRET):
            for service in ("cloudformation", "ssm"):
                with self.subTest(value=value, service=service):
                    self.cloud = Cloud()
                    response = stack_response(value) if service == "cloudformation" \
                        else parameter_response(value)
                    self.cloud.responses[service] = response
                    result = self.check()
                    self.assertEqual(result["status"], "invalid_metadata")
                    self.assertFalse(result["ready"])

    def test_cli_uses_seoul_and_the_nonempty_atlas_account_environment_default(self):
        code, result = self.cli(env={
            "ATLAS_ACCOUNT": ACCOUNT, "AWS_REGION": "us-east-1",
            "AWS_DEFAULT_REGION": "eu-west-1", "AWS_BEARER_TOKEN_BEDROCK": SECRET,
        })
        self.assertEqual(code, 0)
        self.assertTrue(result["ready"])
        self.assertEqual(result["region"], "ap-northeast-2")
        self.assertEqual(result["expectedAccount"], ACCOUNT)

    def test_cli_empty_account_environment_leaves_expectation_unset(self):
        code, result = self.cli(env={"ATLAS_ACCOUNT": ""})
        self.assertEqual(code, 0)
        self.assertIsNone(result["expectedAccount"])

    def test_cli_account_override_wins_over_the_environment(self):
        code, result = self.cli(
            ["--expected-account", ACCOUNT], env={"ATLAS_ACCOUNT": "999999999999"})
        self.assertEqual(code, 0)
        self.assertEqual(result["expectedAccount"], ACCOUNT)

    def test_cli_wrong_account_cannot_be_bypassed_by_require_missing(self):
        self.cloud.responses.update(cloudformation=missing_stack(),
                                    ssm=ServiceError("ParameterNotFound"))
        code, result = self.cli(["--require-missing"], env={"ATLAS_ACCOUNT": "999999999999"})
        self.assertEqual(code, 1)
        self.assertEqual(result["status"], "account_mismatch")
        self.assertEqual(self.cloud.factories, ["sts"])

    def test_cli_malformed_expected_account_is_json_and_never_repeated(self):
        for args, env in ((["--expected-account", SECRET], {}),
                          ([], {"ATLAS_ACCOUNT": SECRET}),
                          ([], {"ATLAS_ACCOUNT": " "})):
            with self.subTest(args=args, env=env):
                self.cloud = Cloud()
                code, result = self.cli(args, env)
                self.assertEqual(code, 1)
                self.assertEqual(result["status"], "invalid_input")
                self.assertFalse(result["ready"])
                self.assertEqual(self.cloud.factories, [])

    def test_missing_is_failure_normally_but_expected_by_the_absence_guard(self):
        self.cloud.responses.update(cloudformation=missing_stack(),
                                    ssm=ServiceError("ParameterNotFound"))
        code, result = self.cli()
        self.assertEqual(code, 1)
        self.assertEqual(result["status"], "missing")
        self.assertFalse(result["ready"])
        code, result = self.cli(["--require-missing"])
        self.assertEqual(code, 0)
        self.assertEqual(result["status"], "missing")
        self.assertFalse(result["ready"])
        self.assertTrue(result["requireMissing"])

    def test_require_missing_never_permits_existing_partial_or_unverifiable_setups(self):
        cases = [
            (stack_response(), parameter_response(), "ready"),
            (stack_response("31"), parameter_response("31"), "ready"),
            (stack_response("29"), parameter_response("29"), "outdated"),
            (missing_stack(), parameter_response(), "inconsistent"),
            (stack_response(), ServiceError("ParameterNotFound"), "inconsistent"),
            (stack_response("30"), parameter_response("31"), "inconsistent"),
            (stack_response(status="CREATE_IN_PROGRESS"), parameter_response(), "not_ready"),
            (ServiceError("AccessDenied"), ServiceError("ParameterNotFound"), "access_denied"),
            (missing_stack(), TimeoutError(SECRET), "network_error"),
            ({"Stacks": []}, ServiceError("ParameterNotFound"), "invalid_metadata"),
            (ServiceError("ValidationError"), ServiceError("ParameterNotFound"), "error"),
        ]
        for stack, parameter, status in cases:
            with self.subTest(status=status):
                self.cloud = Cloud()
                self.cloud.responses.update(cloudformation=stack, ssm=parameter)
                code, result = self.cli(["--require-missing"])
                self.assertEqual(code, 1)
                self.assertEqual(result["status"], status)

    def test_default_exit_code_is_zero_only_for_ready(self):
        cases = [
            (stack_response(), parameter_response(), 0),
            (stack_response("29"), parameter_response("29"), 1),
            (missing_stack(), ServiceError("ParameterNotFound"), 1),
            (stack_response(), ServiceError("ParameterNotFound"), 1),
            (stack_response("31"), parameter_response("30"), 1),
            (stack_response(status="UPDATE_IN_PROGRESS"), parameter_response(), 1),
            (ServiceError("AccessDenied"), parameter_response(), 1),
        ]
        for stack, parameter, expected in cases:
            with self.subTest(expected=expected):
                self.cloud = Cloud()
                self.cloud.responses.update(cloudformation=stack, ssm=parameter)
                code, result = self.cli()
                self.assertEqual(code, expected)
                self.assertEqual(result["ready"], expected == 0)

    def test_default_boto_factory_bounds_all_clients_and_uses_only_seoul(self):
        configured = []

        def client(service, **kwargs):
            configured.append((service, kwargs))
            return self.cloud.client(service)

        with patch("boto3.client", side_effect=client):
            result = self.module.check(expected_account=ACCOUNT)
        self.assertTrue(result["ready"])
        self.assertEqual([service for service, _ in configured],
                         ["sts", "cloudformation", "ssm"])
        for service, kwargs in configured:
            with self.subTest(service=service):
                self.assertEqual(kwargs["region_name"], "ap-northeast-2")
                config = kwargs["config"]
                self.assertEqual(config.connect_timeout, 5)
                self.assertEqual(config.read_timeout, 15)
                self.assertEqual(config.retries,
                                 {"total_max_attempts": 1, "mode": "standard"})

    def test_help_runs_without_site_packages_or_aws_sdk(self):
        result = subprocess.run(
            [sys.executable, "-B", "-S", str(SCRIPT), "--help"],
            env={"PATH": os.defpath}, capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--require-missing", result.stdout)
        self.assertIn("--expected-account", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_cli_without_the_sdk_returns_masked_json_and_cannot_pass_the_guard(self):
        for args in ([], ["--require-missing"]):
            with self.subTest(args=args):
                result = subprocess.run(
                    [sys.executable, "-B", "-S", str(SCRIPT)] + args,
                    env={"PATH": os.defpath}, capture_output=True, text=True, timeout=5,
                )
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(result.stderr, "")
                report = json.loads(result.stdout)
                self.assertEqual(report["status"], "sdk_unavailable")
                self.assertFalse(report["ready"])

    def test_core_fixture_copies_checker_and_source_check_requires_it(self):
        from workshop.tests.test_core import copy_core_source

        spec = importlib.util.spec_from_file_location(
            "workshop_core_for_bootstrap_test", ROOT / "workshop/scripts/core.py")
        core = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(core)
        with tempfile.TemporaryDirectory(prefix="atlas-cdk-source-") as directory:
            repo = Path(directory) / "source"
            copy_core_source(repo)
            checker = repo / "workshop/scripts/cdk_bootstrap.py"
            self.assertTrue(checker.is_file(), "Core source fixture omitted bootstrap preflight")
            self.assertEqual(core.check_source(repo), repo)
            checker.unlink()
            with self.assertRaisesRegex(ValueError, "cdk_bootstrap.py"):
                core.check_source(repo)


if __name__ == "__main__":
    unittest.main()
