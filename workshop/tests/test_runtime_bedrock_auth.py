"""Offline checks for the workshop Runtime's SSM-backed Bedrock authentication.

Only the HTTP transport is replaced: boto3 builds, serializes and signs real
requests. All credentials and responses are synthetic; unexpected network
access fails the test.
"""

import builtins
from contextlib import ExitStack
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import traceback
import unittest
from unittest.mock import patch
import zlib

import boto3
from botocore.awsrequest import AWSResponse
from botocore.config import Config
from botocore.exceptions import ClientError, EndpointConnectionError, EventStreamError


ADAPTER = Path(__file__).resolve().parents[1] / "runtime/bedrock_auth.py"
ARN = (
    "arn:aws:ssm:ap-northeast-2:123456789012:"
    "parameter/jeju-atlas-lab-team01/bedrock-api-key"
)
NAME = "/jeju-atlas-lab-team01/bedrock-api-key"
REGION = "ap-northeast-2"
KEY = "synthetic-workshop-bedrock-key-v1+/="
RENEWED_KEY = "synthetic-workshop-bedrock-key-v2+/="
AMBIENT_KEY = "synthetic-unrelated-process-key"
MODEL_ID = "global.anthropic.claude-sonnet-4-6"
STRANDS_AVAILABLE = importlib.util.find_spec("strands") is not None


class PreparedRequest(BaseException):
    """Stop after signing, before the HTTP transport or any real model call."""


class ResponseBody:
    def __init__(self, payload):
        self.body = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        self.closed = False

    def stream(self, amt=None, decode_content=False):
        yield self.body

    def close(self):
        self.closed = True


def event_frame(kind, name, payload):
    """Encode synthetic AWS event-stream frames for the real botocore parser."""
    values = {
        ":message-type": kind,
        ":event-type" if kind == "event" else ":exception-type": name,
        ":content-type": "application/json",
    }
    headers = b""
    for key, value in values.items():
        key, value = key.encode(), value.encode()
        headers += bytes([len(key)]) + key + b"\x07" + struct.pack(">H", len(value)) + value
    body = json.dumps(payload).encode()
    prelude = struct.pack(">II", 16 + len(headers) + len(body), len(headers))
    message = prelude + struct.pack(">I", zlib.crc32(prelude)) + headers + body
    return message + struct.pack(">I", zlib.crc32(message))


def parameter(*, key=KEY, version=7, **overrides):
    value = {
        "Name": NAME,
        "ARN": ARN,
        "Type": "SecureString",
        "Value": key,
        "Version": version,
        "LastModifiedDate": 1700000000.0,
        "DataType": "text",
    }
    value.update(overrides)
    return {"Parameter": value}


class RuntimeBedrockAuthTests(unittest.TestCase):
    def setUp(self):
        self.scope = ExitStack()
        self.addCleanup(self.scope.close)
        self.scope.enter_context(patch.dict(
            os.environ,
            {
                "ATLAS_BEDROCK_AUTH": "api-key",
                "ATLAS_BEDROCK_API_KEY_SSM_ARN": ARN,
                "ATLAS_BEDROCK_REGION": REGION,
                "AWS_ACCESS_KEY_ID": "AKIASYNTHETICTESTONLY",
                "AWS_SECRET_ACCESS_KEY": "synthetic-iam-secret",
                "AWS_SESSION_TOKEN": "synthetic-iam-session-token",
                "AWS_DEFAULT_REGION": "us-east-1",
                "AWS_REGION": "us-east-1",
                "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
                "AWS_CONFIG_FILE": os.devnull,
                "BOTO_CONFIG": os.devnull,
                "AWS_EC2_METADATA_DISABLED": "true",
                "AWS_BEARER_TOKEN_BEDROCK": AMBIENT_KEY,
            },
            clear=True,
        ))
        self.scope.enter_context(patch(
            "socket.socket.connect", side_effect=AssertionError("Network access is forbidden"),
        ))
        self.requests = []
        self.ssm_responses = [parameter()]
        self.model_responses = []
        self.scope.enter_context(patch("botocore.httpsession.URLLib3Session.send", side_effect=self.send))
        self.assertTrue(ADAPTER.is_file(), "The workshop Runtime auth adapter is missing")
        spec = importlib.util.spec_from_file_location("workshop_runtime_auth_test", ADAPTER)
        self.auth = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.auth)

    def send(self, request):
        self.requests.append(request)
        if request.url == "https://ssm.ap-northeast-2.amazonaws.com/":
            self.assertEqual(
                json.loads(request.body),
                {"Name": ARN, "WithDecryption": True},
            )
            self.assertTrue(self.ssm_responses, "Unexpected additional SSM read")
            response = self.ssm_responses.pop(0)
        elif request.url.startswith("https://bedrock-runtime.ap-northeast-2.amazonaws.com/"):
            self.assertTrue(self.model_responses, "Unexpected model transport call")
            response = self.model_responses.pop(0)
        else:
            self.fail("Unexpected HTTP destination")
        if isinstance(response, Exception):
            raise response
        status, body = response if isinstance(response, tuple) else (200, response)
        self.last_body = ResponseBody(body)
        content_type = "application/vnd.amazon.eventstream" if isinstance(body, bytes) else "application/json"
        return AWSResponse(request.url, status, {"content-type": content_type}, self.last_body)

    def model_client(self, options):
        session = options["boto_session"]
        return session.client(
            "bedrock-runtime",
            region_name=session.region_name,
            **({"config": options["boto_client_config"]} if "boto_client_config" in options else {}),
        )

    def prepared(self, client, operation, **kwargs):
        captured = []

        def stop(request, **unused):
            captured.append(request)
            raise PreparedRequest()

        event = f"before-send.{client.meta.service_model.service_id.hyphenize()}"
        client.meta.events.register(event, stop, unique_id="workshop-auth-test-stop")
        self.addCleanup(client.meta.events.unregister, event, unique_id="workshop-auth-test-stop")
        with self.assertRaises(PreparedRequest):
            getattr(client, operation)(**kwargs)
        self.assertEqual(len(captured), 1)
        return captured[0]

    def assert_bearer(self, request, key=KEY):
        self.assertEqual(request.headers["Authorization"], f"Bearer {key}".encode())
        self.assertNotIn("X-Amz-Security-Token", request.headers)
        self.assertNotIn("X-Amz-Date", request.headers)
        self.assertTrue(request.url.startswith("https://bedrock-runtime.ap-northeast-2.amazonaws.com/"))

    def assert_iam(self, request):
        authorization = request.headers["Authorization"].decode()
        self.assertTrue(authorization.startswith("AWS4-HMAC-SHA256 "))
        self.assertIn("Credential=AKIASYNTHETICTESTONLY/", authorization)
        self.assertEqual(request.headers["X-Amz-Security-Token"], b"synthetic-iam-session-token")
        self.assertNotIn(KEY, authorization)
        self.assertNotIn(AMBIENT_KEY, authorization)

    def assert_redacted_failure(self, operation, *secrets):
        with self.assertRaises(RuntimeError) as caught:
            operation()
        rendered = "".join(traceback.format_exception(caught.exception))
        for secret in secrets:
            self.assertNotIn(secret, rendered)
            self.assertNotIn(secret, repr(caught.exception))
        self.assertIsNone(caught.exception.__context__, "Do not retain the original SDK exception")
        return caught.exception

    def test_contract_reads_exact_secure_parameter_with_iam(self):
        before = dict(os.environ)
        identity, options = self.auth.prepare_model_auth()
        self.assertEqual(identity, ("api-key", ARN, REGION, 7))
        self.assertEqual(hash(identity), hash(("api-key", ARN, REGION, 7)))
        self.assertIsInstance(options["boto_session"], boto3.session.Session)
        self.assertEqual(options["boto_session"].region_name, REGION)
        # Merging these options must neutralize the generated loader's region:
        # Strands rejects a nonempty region_name together with boto_session.
        self.assertIsNone({**{"region_name": REGION}, **options}["region_name"])
        self.assertNotIn(KEY, repr((identity, options)))
        self.assertEqual(os.environ, before)
        self.assertEqual(len(self.requests), 1)
        self.assert_iam(self.requests[0])

    def test_converse_and_converse_stream_prepare_bearer_headers(self):
        _, options = self.auth.prepare_model_auth()
        for operation, suffix in (
            ("converse", "/converse"),
            ("converse_stream", "/converse-stream"),
        ):
            with self.subTest(operation=operation):
                client = self.model_client(options)
                self.addCleanup(client.close)
                request = self.prepared(
                    client, operation, modelId=MODEL_ID,
                    messages=[{"role": "user", "content": [{"text": "offline fixture"}]}],
                )
                self.assert_bearer(request)
                self.assertTrue(request.url.endswith(suffix))
        self.assertEqual(len(self.requests), 1)  # SSM only; model requests stopped before transport.

    @unittest.skipUnless(STRANDS_AVAILABLE, "Use the pinned Guide environment for the Strands constructor check")
    def test_options_merge_into_real_strands_and_both_model_calls_use_bearer(self):
        from strands.models.bedrock import BedrockModel

        _, options = self.auth.prepare_model_auth()
        model = BedrockModel(**{
            "model_id": MODEL_ID, "region_name": REGION, "max_tokens": 16, **options,
        })
        self.addCleanup(model.client.close)
        for operation in ("converse", "converse_stream"):
            with self.subTest(operation=operation):
                request = self.prepared(model.client, operation, modelId=MODEL_ID)
                self.assert_bearer(request)
                model.client.meta.events.unregister(
                    "before-send.bedrock-runtime", unique_id="workshop-auth-test-stop",
                )

    def test_renewal_changes_identity_and_new_cached_client_uses_new_key(self):
        self.ssm_responses = [parameter(), parameter(), parameter(key=RENEWED_KEY, version=8)]
        cached_identity = None
        cache = {}
        clients = []
        identities = []
        for _ in range(3):
            identity, options = self.auth.prepare_model_auth()
            if identity != cached_identity:
                cache.clear()
                cached_identity = identity
            if MODEL_ID not in cache:
                cache[MODEL_ID] = self.model_client(options)
                self.addCleanup(cache[MODEL_ID].close)
            clients.append(cache[MODEL_ID])
            identities.append(identity)
        self.assertEqual(identities[0], identities[1])
        self.assertNotEqual(identities[1], identities[2])
        self.assertIs(clients[0], clients[1])
        self.assertIsNot(clients[1], clients[2])
        self.assert_bearer(self.prepared(clients[0], "converse", modelId=MODEL_ID))
        self.assert_bearer(
            self.prepared(clients[2], "converse_stream", modelId=MODEL_ID), RENEWED_KEY,
        )
        self.assertNotIn(RENEWED_KEY, repr(identities))
        self.assertEqual(len(self.requests), 3)

    def test_version_change_invalidates_identity_even_for_same_key_value(self):
        self.ssm_responses = [parameter(), parameter(version=8)]
        first, _ = self.auth.prepare_model_auth()
        second, _ = self.auth.prepare_model_auth()
        self.assertNotEqual(first, second)

    def test_auth_mode_is_required_and_never_falls_back_to_iam(self):
        for value in (None, "", "iam", "API-KEY", " api-key", KEY):
            with self.subTest(value=value):
                if value is None:
                    os.environ.pop("ATLAS_BEDROCK_AUTH", None)
                else:
                    os.environ["ATLAS_BEDROCK_AUTH"] = value
                self.assert_redacted_failure(self.auth.prepare_model_auth, KEY, AMBIENT_KEY)
        self.assertEqual(self.requests, [])

    def test_only_exact_unversioned_workshop_ssm_arn_is_accepted(self):
        for value in (
            None, "", NAME, ARN + ":7", ARN + ":current", ARN + "\n",
            ARN.replace("arn:aws:", "arn:aws-cn:"),
            ARN.replace("ap-northeast-2", "us-east-1"),
            ARN.replace("123456789012", "123"),
            ARN.replace("team01", "*"),
            ARN.replace("team01", "team01/nested"),
            ARN.replace("bedrock-api-key", "other-secret"),
            KEY,
        ):
            with self.subTest(value=value):
                if value is None:
                    os.environ.pop("ATLAS_BEDROCK_API_KEY_SSM_ARN", None)
                else:
                    os.environ["ATLAS_BEDROCK_API_KEY_SSM_ARN"] = value
                self.assert_redacted_failure(self.auth.prepare_model_auth, KEY, AMBIENT_KEY)
        self.assertEqual(self.requests, [])

    def test_seoul_region_is_explicit_and_has_no_default(self):
        for value in (None, "", "us-west-2", "ap-northeast-2 ", KEY):
            with self.subTest(value=value):
                if value is None:
                    os.environ.pop("ATLAS_BEDROCK_REGION", None)
                else:
                    os.environ["ATLAS_BEDROCK_REGION"] = value
                self.assert_redacted_failure(self.auth.prepare_model_auth, KEY, AMBIENT_KEY)
        self.assertEqual(self.requests, [])

    def test_malformed_or_mismatched_ssm_metadata_fails_closed(self):
        invalid = [
            {}, {"Parameter": None}, {"Parameter": []},
            parameter(Type="String"), parameter(Type="StringList"),
            parameter(ARN=ARN.replace("team01", "team02")),
            parameter(Name=NAME.replace("team01", "team02")),
            parameter(version=0), parameter(version=-1), parameter(version="7"),
            parameter(version=True), parameter(version=None),
        ]
        for field in ("Name", "ARN", "Type", "Version", "Value"):
            response = parameter()
            del response["Parameter"][field]
            invalid.append(response)
        for response in invalid:
            with self.subTest(response=response):
                self.ssm_responses = [response]
                self.assert_redacted_failure(self.auth.prepare_model_auth, KEY)

    def test_invalid_keys_are_rejected_without_echoing_the_value(self):
        for key in (
            None, 123, "", " ", KEY + "\n", "\t" + KEY, "Bearer " + KEY,
            KEY + "\x00", KEY + "\r\nInjected: true", "non-ascii-\N{SNOWMAN}",
            "x" * 8193,
        ):
            with self.subTest(key=key):
                self.ssm_responses = [parameter(key=key)]
                self.assert_redacted_failure(
                    self.auth.prepare_model_auth,
                    *(value for value in (key, KEY) if isinstance(value, str) and value.strip()),
                )

    def test_opaque_short_and_long_keys_are_not_parsed_for_expiration(self):
        for key in ("short.synthetic-key_~+/==", "long-" + "x" * 5000):
            with self.subTest(key=key[:5]):
                self.ssm_responses = [parameter(key=key)]
                _, options = self.auth.prepare_model_auth()
                client = self.model_client(options)
                self.addCleanup(client.close)
                self.assert_bearer(self.prepared(client, "converse", modelId=MODEL_ID), key)

    def test_ssm_sdk_failures_redact_message_code_and_exception_chain(self):
        for response in (
            (400, {"__type": "ParameterNotFound", "message": KEY}),
            (400, {"__type": KEY, "message": KEY}),
            EndpointConnectionError(endpoint_url="https://synthetic.invalid/" + KEY),
            RuntimeError("SDK echoed " + KEY),
        ):
            with self.subTest(error_type=type(response).__name__):
                self.ssm_responses = [response]
                self.assert_redacted_failure(self.auth.prepare_model_auth, KEY, AMBIENT_KEY)

    def test_failed_refresh_never_returns_stale_auth_options(self):
        self.ssm_responses = [
            parameter(),
            (400, {"__type": "AccessDeniedException", "message": "denied " + KEY}),
        ]
        self.auth.prepare_model_auth()
        self.assert_redacted_failure(self.auth.prepare_model_auth, KEY)
        self.assertEqual(len(self.requests), 2)

    def test_token_provider_setup_failure_does_not_retain_the_sdk_error(self):
        with patch.object(
            self.auth, "ScopedEnvTokenProvider", side_effect=RuntimeError("SDK setup echoed " + KEY),
        ):
            self.assert_redacted_failure(self.auth.prepare_model_auth, KEY)

    def test_process_key_cannot_replace_ssm_and_other_clients_keep_iam(self):
        before = dict(os.environ)
        _, options = self.auth.prepare_model_auth()
        # Runtime Gateway uses SigV4 with the bedrock-agentcore signing name;
        # Memory uses this same service's SDK client.
        for service, operation, kwargs in (
            ("ssm", "get_parameter", {"Name": NAME, "WithDecryption": True}),
            ("bedrock-agentcore", "list_events", {
                "memoryId": "syntheticmemory-0123456789",
                "sessionId": "synthetic-session",
                "actorId": "synthetic-actor",
            }),
        ):
            with self.subTest(service=service):
                client = boto3.session.Session(region_name=REGION).client(service)
                self.addCleanup(client.close)
                self.assert_iam(self.prepared(client, operation, **kwargs))
        self.assertEqual(os.environ, before)
        client = self.model_client(options)
        self.addCleanup(client.close)
        self.assert_bearer(self.prepared(client, "converse", modelId=MODEL_ID))

    def test_absent_global_bearer_stays_absent_through_request_signing(self):
        del os.environ["AWS_BEARER_TOKEN_BEDROCK"]
        _, options = self.auth.prepare_model_auth()
        client = self.model_client(options)
        self.addCleanup(client.close)
        self.assert_bearer(self.prepared(client, "converse_stream", modelId=MODEL_ID))
        self.assertNotIn("AWS_BEARER_TOKEN_BEDROCK", os.environ)

    def test_runtime_never_reads_a_local_dotenv(self):
        original_open, original_io_open = builtins.open, io.open

        def guard(delegate):
            def checked(path, *args, **kwargs):
                if isinstance(path, (str, os.PathLike)) and Path(path).name.startswith(".env"):
                    self.fail("Runtime attempted to read a local .env")
                return delegate(path, *args, **kwargs)
            return checked

        with patch("builtins.open", side_effect=guard(original_open)), patch(
            "io.open", side_effect=guard(original_io_open),
        ):
            self.auth.prepare_model_auth()
            del os.environ["ATLAS_BEDROCK_API_KEY_SSM_ARN"]
            self.assert_redacted_failure(self.auth.prepare_model_auth, KEY)

    def test_model_auth_denials_are_redacted_without_iam_fallback(self):
        _, options = self.auth.prepare_model_auth()
        for operation in ("converse", "converse_stream"):
            with self.subTest(operation=operation):
                self.model_responses = [
                    (403, {"__type": "AccessDeniedException", "message": "rejected " + KEY}),
                ]
                client = self.model_client(options)
                self.addCleanup(client.close)
                before = len(self.requests)
                with self.assertRaises(ClientError) as caught:
                    getattr(client, operation)(modelId=MODEL_ID)
                self.assertNotIn(KEY, "".join(traceback.format_exception(caught.exception)))
                self.assertNotIn(KEY, repr(caught.exception.response))
                self.assertEqual(caught.exception.response["Error"]["Code"], "AccessDeniedException")
                self.assertEqual(len(self.requests), before + 1)
                self.assert_bearer(self.requests[-1])

    def test_model_transport_and_constructor_errors_do_not_echo_keys(self):
        _, options = self.auth.prepare_model_auth()
        client = self.model_client(options)
        self.addCleanup(client.close)
        self.model_responses = [RuntimeError("SDK transport echoed " + KEY)]
        self.assert_redacted_failure(lambda: client.converse(modelId=MODEL_ID), KEY)
        with patch(
            "botocore.session.Session.create_client", side_effect=RuntimeError("SDK constructor echoed " + KEY),
        ):
            self.assert_redacted_failure(lambda: self.model_client(options), KEY)

    def test_event_stream_errors_are_redacted_after_successful_events(self):
        _, options = self.auth.prepare_model_auth()
        client = self.model_client(options)
        self.addCleanup(client.close)
        self.model_responses = [
            event_frame("event", "messageStart", {"role": "assistant"})
            + event_frame("exception", "internalServerException", {"message": "stream echoed " + KEY}),
        ]
        response = client.converse_stream(modelId=MODEL_ID)
        stream = response["stream"]
        events = iter(stream)
        self.assertEqual(next(events), {"messageStart": {"role": "assistant"}})
        with self.assertRaises(EventStreamError) as caught:
            next(events)
        self.assertNotIn(KEY, "".join(traceback.format_exception(caught.exception)))
        self.assertNotIn(KEY, repr(caught.exception.response))
        self.assertEqual(caught.exception.response["Error"]["Code"], "internalServerException")
        stream.close()
        self.assertTrue(self.last_body.closed)
        self.assert_bearer(self.requests[-1])

    def test_model_session_cannot_send_the_key_to_other_services(self):
        _, options = self.auth.prepare_model_auth()
        for service in ("ssm", "bedrock-agentcore", "bedrock"):
            with self.subTest(service=service):
                self.assert_redacted_failure(lambda: options["boto_session"].client(service), KEY)
        self.assertEqual(len(self.requests), 1)

    def test_model_session_forces_bearer_without_overwriting_other_client_settings(self):
        _, options = self.auth.prepare_model_auth()
        client = options["boto_session"].client(
            "bedrock-runtime",
            config=Config(signature_version="v4", read_timeout=321, user_agent_extra="synthetic-caller"),
        )
        self.addCleanup(client.close)
        self.assertEqual(client.meta.config.read_timeout, 321)
        self.assertEqual(client.meta.config.user_agent_extra, "synthetic-caller")
        self.assert_bearer(self.prepared(client, "converse", modelId=MODEL_ID))


if __name__ == "__main__":
    unittest.main()
