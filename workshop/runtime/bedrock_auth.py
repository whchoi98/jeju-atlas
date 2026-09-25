"""Workshop-only Bedrock API-key authentication for the generated Guide.

Copy this module to ``agent/guide/model/workshop_auth.py`` in the participant
app. Call ``prepare_model_auth`` BEFORE looking up a cached model, clear the
model cache when its returned identity changes, and merge its options LAST
into the ``BedrockModel`` kwargs.

There is deliberately no IAM model fallback or local dotenv loading. Every
preparation reads the latest SSM version; an unsuccessful refresh must stop
the invocation even when a previous model is cached.
"""

from functools import wraps
import os
import re
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from botocore.session import Session as BotocoreSession
from botocore.tokens import ScopedEnvTokenProvider


_REGION = "ap-northeast-2"
_PARAMETER_ARN = re.compile(
    r"arn:aws:ssm:ap-northeast-2:[0-9]{12}:"
    r"parameter/jeju-atlas-lab-[a-z0-9]+/bedrock-api-key"
)
# RFC 6750's opaque bearer syntax, shared by short- and long-term API keys.
# Do not infer a key's type or expiration from its contents.
_BEARER = re.compile(r"[A-Za-z0-9._~+/-]+=*")


class BedrockAuthError(RuntimeError):
    """Safe-to-report workshop authentication failure, without SDK payloads."""


def _redact(value: Any, key: str) -> Any:
    if isinstance(value, str):
        return value.replace(key, "[REDACTED]")
    if isinstance(value, dict):
        return {_redact(name, key): _redact(item, key) for name, item in value.items()}
    if isinstance(value, list):
        return [_redact(item, key) for item in value]
    return value


def _safe_error(error: Exception, key: str) -> Exception:
    if isinstance(error, ClientError):
        # Retain SDK error types/codes for Strands' throttling and model-error
        # handling, including EventStreamError. Do not retain the raw traceback.
        return type(error)(_redact(error.response, key), _redact(error.operation_name, key))
    return BedrockAuthError("The workshop Bedrock model SDK request failed")


def _safe_call(operation, key: str, *args, **kwargs):
    try:
        return operation(*args, **kwargs)
    except Exception as error:
        safe = _safe_error(error, key)
    # Outside the handler so even __context__ does not retain the raw SDK error.
    raise safe from None


class _RedactedStream:
    def __init__(self, stream, key: str):
        self._stream = stream
        self._key = key

    def __iter__(self):
        try:
            yield from self._stream
        except Exception as error:
            safe = _safe_error(error, self._key)
        else:
            return
        raise safe from None

    def close(self):
        return _safe_call(self._stream.close, self._key)


class _ModelClient:
    """Keep real boto3 behavior while redacting model and deferred stream errors."""

    def __init__(self, client, key: str):
        self._client = client
        self._key = key

    def __getattr__(self, name):
        attribute = getattr(self._client, name)
        if not callable(attribute):
            return attribute

        @wraps(attribute)
        def call(*args, **kwargs):
            result = _safe_call(attribute, self._key, *args, **kwargs)
            if isinstance(result, dict) and "stream" in result:
                result = {**result, "stream": _RedactedStream(result["stream"], self._key)}
            return result

        return call


class _ModelSession(boto3.session.Session):
    """A dedicated session for model clients; ordinary AWS sessions stay IAM."""

    def __init__(self, key: str, core_session: BotocoreSession):
        super().__init__(botocore_session=core_session, region_name=_REGION)
        self._key = key

    def client(self, service_name, **kwargs):
        if service_name != "bedrock-runtime":
            raise BedrockAuthError("The workshop model session only supports bedrock-runtime")
        try:
            config = kwargs.get("config") or Config()
            # Force Bearer even with an in-code SigV4 preference. Merging here
            # preserves Strands' read timeout, user agent and retry settings.
            kwargs["config"] = config.merge(Config(signature_version="bearer"))
            client = super().client(service_name, **kwargs)
        except Exception as error:
            safe = _safe_error(error, self._key)
        else:
            return _ModelClient(client, self._key)
        raise safe from None


def prepare_model_auth() -> tuple[tuple[str, str, str, int], dict[str, Any]]:
    """Return ``(("api-key", parameter_arn, region, version), model_kwargs)``.

    ``model_kwargs`` contains a dedicated boto3 session that forces Bearer for
    model clients. ``region_name=None`` overrides any generated loader region:
    Strands 1.54 disallows a nonempty region alongside ``boto_session``.
    The session itself is pinned to Seoul.

    The identity contains no key, key hash, or expiration data. Reading SSM on
    every call lets the caller invalidate already-cached Bedrock clients on
    key renewal. SSM uses the normal IAM credential chain with explicit SigV4;
    the key is installed only in a separate model session's token provider.
    """
    if os.environ.get("ATLAS_BEDROCK_AUTH") != "api-key":
        raise BedrockAuthError("ATLAS_BEDROCK_AUTH must be api-key for the workshop Guide")
    arn = os.environ.get("ATLAS_BEDROCK_API_KEY_SSM_ARN", "")
    if not _PARAMETER_ARN.fullmatch(arn):
        raise BedrockAuthError("Set an exact, unversioned workshop Bedrock SSM parameter ARN in Seoul")
    if os.environ.get("ATLAS_BEDROCK_REGION") != _REGION:
        raise BedrockAuthError("ATLAS_BEDROCK_REGION must be ap-northeast-2 for the workshop Guide")

    try:
        iam_session = boto3.session.Session(region_name=_REGION)
        ssm = iam_session.client(
            "ssm",
            config=Config(
                signature_version="v4",
                connect_timeout=5,
                read_timeout=10,
                retries={"total_max_attempts": 1},
            ),
        )
        try:
            response = ssm.get_parameter(Name=arn, WithDecryption=True)
        finally:
            ssm.close()
    except Exception:
        # SDK messages, error codes and chained exceptions can echo secrets.
        # Leave the handler before raising, so the SDK error is not retained
        # as __context__ even by reporters that inspect suppressed exceptions.
        response = None
    if response is None:
        raise BedrockAuthError("Unable to read the workshop Bedrock API key from SSM") from None

    parameter = response.get("Parameter") if isinstance(response, dict) else None
    if (
        not isinstance(parameter, dict)
        or parameter.get("Type") != "SecureString"
        or parameter.get("ARN") != arn
        or parameter.get("Name") != arn.split(":parameter", 1)[1]
        or type(parameter.get("Version")) is not int
        or parameter["Version"] <= 0
    ):
        raise BedrockAuthError("SSM did not return the expected versioned SecureString")
    key = parameter.get("Value")
    if not isinstance(key, str) or not 1 <= len(key) <= 8192 or not _BEARER.fullmatch(key):
        raise BedrockAuthError("SSM contains an invalid workshop Bedrock API key")

    try:
        core_session = BotocoreSession()
        # boto3/botocore 1.43.89 support explicit botocore_session injection,
        # register_component, and ScopedEnvTokenProvider(environ=...). The
        # provider uses this private mapping, never the process environment.
        core_session.register_component(
            "token_provider",
            ScopedEnvTokenProvider(core_session, environ={"AWS_BEARER_TOKEN_BEDROCK": key}),
        )
        model_session = _ModelSession(key, core_session)
        options = {
            "boto_session": model_session,
            "region_name": None,
        }
    except Exception:
        options = None
    if options is None:
        raise BedrockAuthError("Unable to configure SDK Bearer authentication for the workshop Guide") from None
    return ("api-key", arn, _REGION, parameter["Version"]), options
