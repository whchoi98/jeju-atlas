"""Deployed-runtime secret source: SSM Parameter Store SecureString under a prefix.

This optional source is consulted only when an env var is missing AND
ATLAS_SECRETS_SSM_PREFIX is explicitly set. Atlas deployment leaves it unset;
no reference-project parameter prefix or role policy is shipped by this package.
Runtime permissions belong to infra/agentcore.yaml.
"""
from __future__ import annotations

import logging
import os

log = logging.getLogger(__name__)
PREFIX_ENV = "ATLAS_SECRETS_SSM_PREFIX"


def _client():
    import boto3  # imported lazily: not needed for local dev/tests

    return boto3.client("ssm", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))


def lookup(name: str) -> str | None:
    prefix = os.environ.get(PREFIX_ENV)
    if not prefix:
        return None
    param = f"{prefix.rstrip('/')}/{name}"
    try:
        return _client().get_parameter(Name=param, WithDecryption=True)["Parameter"]["Value"]
    except Exception as exc:  # ParameterNotFound, AccessDenied, no credentials …
        log.info("ssm secret %s not available: %s", param, type(exc).__name__)
        return None
