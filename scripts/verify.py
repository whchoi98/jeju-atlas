#!/usr/bin/env python3
"""Verify the deployed Jeju app, network placement and origin restrictions."""
from __future__ import annotations

from datetime import datetime, timezone
import json
import re
import sys

import requests
from deploy import (
    ACCOUNT, APP, LOCAL, PREFIX, PRIVATE, PUBLIC, REGION, VPC, SETTINGS,
    assert_network, connect, emit, load, normalize_routing_image, routing_parameters,
    save, stack_outputs, validate_settings,
)


def verify_task_configuration(taskdef, parameters, settings, image, check):
    """Compare actual ECS configuration with the selected release and validated sizing."""
    try:
        expected = routing_parameters(image, settings, parameters)
    except (ValueError, TypeError, KeyError):
        check("Task sizing and routing release selection are valid", False)
        return
    defaults = {"TaskCpu": "256", "TaskMemory": "512"}
    check("CloudFormation capacity matches validated settings", all(
        str(parameters.get(key, default)) == expected[key] for key, default in defaults.items()
    ))
    platform = taskdef.get("runtimePlatform", {})
    check("ARM64 Linux Fargate capacity matches deployment configuration",
          platform.get("cpuArchitecture") == "ARM64" and platform.get("operatingSystemFamily") == "LINUX"
          and "FARGATE" in taskdef.get("requiresCompatibilities", []) and taskdef.get("networkMode") == "awsvpc"
          and str(taskdef.get("cpu")) == expected["TaskCpu"] and str(taskdef.get("memory")) == expected["TaskMemory"])
    containers = taskdef.get("containerDefinitions", [])
    web = [item for item in containers if item.get("name") == "web"]
    routers = [item for item in containers if item.get("name") == "routing"]
    check("Exactly one web container is selected by name", len(web) == 1)
    web = web[0] if len(web) == 1 else {}
    environment = {item["name"]: item["value"] for item in web.get("environment", [])}
    check("CloudFormation routing matches the immutable release pair",
          parameters.get("RoutingImageUri", "") == expected["RoutingImageUri"]
          and parameters.get("RoutingDataUpdatedAt", "") == expected["RoutingDataUpdatedAt"])
    if not expected["RoutingImageUri"]:
        check("Routing remains absent without a paired release",
              not routers and "ROUTING_URL" not in environment and "ROUTING_DATA_UPDATED_AT" not in environment
              and not any(item.get("containerName") == "routing" for item in web.get("dependsOn", []))
              and not any(item.get("name") == "routing-cache" for item in taskdef.get("volumes", [])))
        return

    router = routers[0] if len(routers) == 1 else {}
    check("Exactly one native router uses the paired immutable image",
          len(routers) == 1 and router.get("image") == expected["RoutingImageUri"])
    check("Web routing URL and source timestamp use the selected local engine",
          environment.get("ROUTING_URL") == "http://127.0.0.1:8002"
          and environment.get("ROUTING_DATA_UPDATED_AT") == expected["RoutingDataUpdatedAt"])
    capabilities = router.get("linuxParameters", {}).get("capabilities", {})
    check("Native router is nonroot and read-only without exposed ports or secrets",
          router.get("user") == "65532:65532" and router.get("readonlyRootFilesystem") is True
          and not router.get("privileged", False) and not router.get("portMappings")
          and not router.get("secrets") and not router.get("environment") and not router.get("environmentFiles")
          and "ALL" in capabilities.get("drop", []) and not capabilities.get("add"))
    check("Native router memory matches the configured task budget",
          str(parameters.get("RoutingMemory", "512")) == expected["RoutingMemory"]
          and router.get("memory") == int(expected["RoutingMemory"])
          and router.get("cpu") == 256 and router.get("memoryReservation") == 256)
    mounts = router.get("mountPoints", [])
    volume = [item for item in taskdef.get("volumes", []) if item.get("name") == "routing-cache"]
    check("Native router writes only its separate ephemeral tmp volume",
          len(mounts) == 1 and mounts[0].get("sourceVolume") == "routing-cache"
          and mounts[0].get("containerPath") == "/tmp" and mounts[0].get("readOnly") is False
          and not any(item.get("sourceVolume") == "routing-cache" for item in web.get("mountPoints", []))
          and len(volume) == 1 and not any(volume[0].get(key) for key in (
              "host", "dockerVolumeConfiguration", "efsVolumeConfiguration", "fsxWindowsFileServerVolumeConfiguration")))
    health = router.get("healthCheck", {})
    check("Native health uses the fixed private status check",
          health.get("command") == ["CMD", "python3", "/opt/routing/healthcheck.py"]
          and 0 < health.get("timeout", 0) <= 5 and 5 <= health.get("interval", 0) <= 60
          and 1 <= health.get("retries", 0) <= 5)
    check("Native failure remains isolated with restart and graceful stop",
          router.get("essential") is False and router.get("restartPolicy", {}).get("enabled") is True
          and router.get("stopTimeout") == 120
          and [item for item in web.get("dependsOn", []) if item.get("containerName") == "routing"]
          == [{"containerName": "routing", "condition": "START"}])


def verify_routing_runtime(tasks, service, enis, outputs, image, check):
    """Use existing describe results; never invoke native routing or a model."""
    network = service.get("networkConfiguration", {}).get("awsvpcConfiguration", {})
    group = outputs.get("TaskSecurityGroupId")
    check("Task service and ENIs use only the selected private security group",
          bool(group) and set(network.get("subnets", [])) == set(PRIVATE)
          and network.get("assignPublicIp") == "DISABLED" and network.get("securityGroups") == [group]
          and bool(tasks) and len(enis) == len(tasks)
          and all(eni.get("VpcId") == VPC and eni.get("SubnetId") in PRIVATE
                  and not eni.get("Association", {}).get("PublicIp")
                  and {item.get("GroupId") for item in eni.get("Groups", [])} == {group} for eni in enis))
    balancers = service.get("loadBalancers", [])
    check("Service load balancing exposes only the web container",
          len(balancers) == 1 and balancers[0].get("containerName") == "web"
          and balancers[0].get("containerPort") == 8080
          and balancers[0].get("targetGroupArn") == outputs.get("TargetGroupArn"))
    paired = image.get("routing")
    if paired is None:
        check("Running tasks have no unconfigured native router",
              not any(item.get("name") == "routing" for task in tasks for item in task.get("containers", [])))
        return
    try:
        uri = normalize_routing_image(paired)["imageUri"]
    except (ValueError, TypeError, KeyError):
        check("Running native router release selection is valid", False)
        return
    healthy = bool(tasks)
    for task in tasks:
        routers = [item for item in task.get("containers", []) if item.get("name") == "routing"]
        healthy = healthy and task.get("taskDefinitionArn") == service.get("taskDefinition") \
            and task.get("lastStatus") == "RUNNING" and len(routers) == 1 \
            and routers[0].get("image") == uri and routers[0].get("lastStatus") == "RUNNING" \
            and routers[0].get("healthStatus") == "HEALTHY"
    check("Every running task has a healthy native router from the selected release", healthy)


def task_iam_scoped(iam, role_name, environment, *, details_bucket=""):
    """Require every selected object/runtime/table grant, with no additional access."""
    if environment.get("DETAILS_BUCKET", "") != details_bucket:
        return False
    if details_bucket and environment.get("DETAILS_KEY") != "place-details/latest.json":
        return False
    expected_resources = {
        "s3:GetObject": {f"arn:aws:s3:::{environment.get('CATALOG_BUCKET')}/catalog/catalog.sqlite"},
        "bedrock-agentcore:InvokeAgentRuntime": {
            environment.get("GUIDE_RUNTIME_ARN"),
            str(environment.get("GUIDE_RUNTIME_ARN")) + "/runtime-endpoint/DEFAULT",
        },
        "bedrock-agentcore:InvokeAgentRuntimeForUser": {
            environment.get("GUIDE_RUNTIME_ARN"),
            str(environment.get("GUIDE_RUNTIME_ARN")) + "/runtime-endpoint/DEFAULT",
        },
        "dynamodb:UpdateItem": {
            f"arn:aws:dynamodb:ap-northeast-2:{ACCOUNT}:table/{environment.get('GUIDE_QUOTA_TABLE')}"
        },
        "dynamodb:GetItem": {
            f"arn:aws:dynamodb:ap-northeast-2:{ACCOUNT}:table/{environment.get('GUIDE_QUOTA_TABLE')}"
        },
    }
    if details_bucket:
        expected_resources["s3:GetObject"].add(f"arn:aws:s3:::{details_bucket}/place-details/latest.json")
    if iam.list_attached_role_policies(RoleName=role_name)["AttachedPolicies"]:
        return False
    granted = {action: set() for action in expected_resources}
    for policy_name in iam.list_role_policies(RoleName=role_name)["PolicyNames"]:
        statements = iam.get_role_policy(RoleName=role_name, PolicyName=policy_name)["PolicyDocument"].get("Statement", [])
        if isinstance(statements, dict):
            statements = [statements]
        for statement in statements:
            actions = statement.get("Action", [])
            resources = statement.get("Resource", [])
            if isinstance(actions, str):
                actions = [actions]
            if isinstance(resources, str):
                resources = [resources]
            if (statement.get("Effect") != "Allow" or not actions or not resources
                    or "NotAction" in statement or "NotResource" in statement
                    or not all(isinstance(value, str) for value in [*actions, *resources])):
                return False
            for action in actions:
                if action not in expected_resources or not set(resources) <= expected_resources[action]:
                    return False
                granted[action].update(resources)
    return granted == expected_resources


def verify_media_delivery(edge, config, parameters, check):
    """Read-only checks for the optional private S3 media origin and its cache."""
    bucket = parameters.get("DetailsBucket", "")
    origins = [item for item in config.get("Origins", {}).get("Items", []) if item.get("Id") == "jeju-media"]
    behaviors = config.get("CacheBehaviors", {}).get("Items", [])
    routes = [item for item in behaviors if item.get("PathPattern") in ("/media/*", "media/*")]
    media_targets = [item for item in behaviors if item.get("TargetOriginId") == "jeju-media"]
    default_is_media = config.get("DefaultCacheBehavior", {}).get("TargetOriginId") == "jeju-media"
    if not bucket:
        check("Media remains disabled without a details bucket",
              not origins and not routes and not media_targets and not default_is_media)
        return

    origin = origins[0] if len(origins) == 1 else {}
    oac_id = parameters.get("MediaOriginAccessControlId", "")
    expected_domain = f"{bucket}.s3.{REGION}.amazonaws.com"
    headers = origin.get("CustomHeaders", {})
    check("Media uses the selected S3 bucket and OAC without ALB credentials", bool(origin)
          and parameters.get("MediaBucketDomainName") == expected_domain
          and origin.get("DomainName") == expected_domain
          and bool(oac_id) and origin.get("OriginAccessControlId") == oac_id
          and origin.get("S3OriginConfig", {}).get("OriginAccessIdentity") == ""
          and not origin.get("CustomOriginConfig") and not origin.get("OriginPath")
          and headers.get("Quantity", 0) == 0 and not headers.get("Items"))
    oac = {}
    if oac_id and origin.get("OriginAccessControlId") == oac_id:
        oac = edge.get_origin_access_control(Id=oac_id)["OriginAccessControl"]["OriginAccessControlConfig"]
    check("Media S3 OAC signs every origin request", oac.get("OriginAccessControlOriginType") == "s3"
          and oac.get("SigningBehavior") == "always" and oac.get("SigningProtocol") == "sigv4")

    behavior = routes[0] if len(routes) == 1 else {}
    methods = behavior.get("AllowedMethods", {})
    check("Only the public media path reaches S3 with GET and HEAD", bool(behavior)
          and behavior.get("PathPattern") == "/media/*" and media_targets == [behavior]
          and not default_is_media and behaviors[0] == behavior
          and behavior.get("ViewerProtocolPolicy") == "redirect-to-https"
          and set(methods.get("Items", [])) == {"GET", "HEAD"}
          and set(methods.get("CachedMethods", {}).get("Items", [])) == {"GET", "HEAD"}
          and behavior.get("Compress") is False and not behavior.get("OriginRequestPolicyId"))
    cache = {}
    if behavior.get("CachePolicyId"):
        cache = edge.get_cache_policy(Id=behavior["CachePolicyId"])["CachePolicy"]["CachePolicyConfig"]
    key = cache.get("ParametersInCacheKeyAndForwardedToOrigin", {})
    check("One-year media cache excludes cookies, headers and query strings",
          cache.get("MinTTL") == 0 and cache.get("DefaultTTL") == 31536000 and cache.get("MaxTTL") == 31536000
          and key.get("CookiesConfig", {}).get("CookieBehavior") == "none"
          and key.get("HeadersConfig", {}).get("HeaderBehavior") == "none"
          and key.get("QueryStringsConfig", {}).get("QueryStringBehavior") == "none"
          and key.get("EnableAcceptEncodingGzip") is False and not key.get("EnableAcceptEncodingBrotli", False))


def verify_assets_delivery(edge, config, parameters, check):
    """Hashed build assets must be independent of the selected ECS task revision."""
    domain = parameters.get("AssetsBucketDomainName", "")
    origins = [item for item in config["Origins"]["Items"] if item["Id"] == "jeju-assets"]
    routes = [item for item in config.get("CacheBehaviors", {}).get("Items", [])
              if item.get("PathPattern") == "/assets/*"]
    if not domain:
        check("Shared asset route is absent when not configured", not origins and not routes)
        return
    origin = origins[0] if len(origins) == 1 else {}
    route = routes[0] if len(routes) == 1 else {}
    oac_id = parameters.get("AssetsOriginAccessControlId", "")
    check("Build assets use the selected private S3 origin without ALB credentials",
          origin.get("DomainName") == domain and bool(oac_id)
          and origin.get("OriginAccessControlId") == oac_id
          and origin.get("S3OriginConfig", {}).get("OriginAccessIdentity") == ""
          and not origin.get("CustomOriginConfig")
          and not origin.get("CustomHeaders", {}).get("Items"))
    control = edge.get_origin_access_control(Id=oac_id)["OriginAccessControl"]["OriginAccessControlConfig"] if oac_id else {}
    check("Build asset OAC signs every S3 request",
          control.get("OriginAccessControlOriginType") == "s3"
          and control.get("SigningBehavior") == "always" and control.get("SigningProtocol") == "sigv4")
    check("Only GET and HEAD build asset requests reach shared storage",
          route.get("TargetOriginId") == "jeju-assets"
          and route.get("ViewerProtocolPolicy") == "redirect-to-https"
          and set(route.get("AllowedMethods", {}).get("Items", [])) == {"GET", "HEAD"}
          and not route.get("OriginRequestPolicyId")
          and not route.get("LambdaFunctionAssociations", {}).get("Items"))
    cache = edge.get_cache_policy(Id=route["CachePolicyId"])["CachePolicy"]["CachePolicyConfig"] if route.get("CachePolicyId") else {}
    key = cache.get("ParametersInCacheKeyAndForwardedToOrigin", {})
    check("Versioned build assets have a one-year public cache without user state",
          cache.get("MinTTL") == 0 and cache.get("DefaultTTL") == 31536000 and cache.get("MaxTTL") == 31536000
          and key.get("CookiesConfig", {}).get("CookieBehavior") == "none"
          and key.get("HeadersConfig", {}).get("HeaderBehavior") == "none"
          and key.get("QueryStringsConfig", {}).get("QueryStringBehavior") == "none"
          and key.get("EnableAcceptEncodingGzip") is True and key.get("EnableAcceptEncodingBrotli") is True)


def verify_origin_routing(edge, config, parameters, settings, outputs, check):
    """Verify DNS or canonical-Host TLS without reading request bodies or secrets."""
    mode = settings.get("OriginTlsMode", "dns")
    use_tls = settings["OriginTlsEnabled"] == "true"
    canonical = use_tls and mode == "canonical-host"
    check("Origin TLS mode matches the deployed parameters", mode in ("dns", "canonical-host")
          and parameters.get("OriginTlsMode", "dns") == mode
          and parameters.get("OriginTlsEnabled", "false") == settings["OriginTlsEnabled"])
    origin = next((item for item in config["Origins"]["Items"] if item["Id"] == "jeju-alb"), {})
    expected_domain = settings["OriginDomainName"] if use_tls and not canonical else outputs["LoadBalancerDnsName"]
    check("CloudFront uses the configured ALB origin", origin.get("DomainName") == expected_domain)
    check("Origin protocol matches the staged TLS configuration",
          origin.get("CustomOriginConfig", {}).get("OriginProtocolPolicy") == ("https-only" if use_tls else "http-only"))
    version = parameters.get("OriginHostFunctionVersionArn", "")
    if canonical:
        check("Canonical Host TLS uses the selected viewer identity and a published owned function",
              bool(settings.get("ViewerDomainName"))
              and parameters.get("ViewerDomainName") == settings["ViewerDomainName"]
              and bool(parameters.get("ViewerCertificateArn")) and bool(parameters.get("OriginCertificateArn"))
              and re.fullmatch(rf"arn:aws:lambda:us-east-1:{ACCOUNT}:function:jeju-3d-origin-host:[1-9][0-9]*", version) is not None)

    policies = {}

    def request_policy(behavior):
        policy_id = behavior.get("OriginRequestPolicyId")
        if not policy_id:
            return {}
        if policy_id not in policies:
            policies[policy_id] = edge.get_origin_request_policy(Id=policy_id)["OriginRequestPolicy"]["OriginRequestPolicyConfig"]
        return policies[policy_id]

    behaviors = [config["DefaultCacheBehavior"], *config.get("CacheBehaviors", {}).get("Items", [])]
    alb_paths = [item.get("PathPattern") for item in behaviors if item.get("TargetOriginId") == "jeju-alb"]
    check("Only default and the two API behaviors reach the ALB",
          len(alb_paths) == 3 and set(alb_paths) == {None, "/api/catalog/*", "/api/*"})
    for behavior in behaviors:
        path = behavior.get("PathPattern", "default")
        associations = behavior.get("LambdaFunctionAssociations", {}).get("Items", [])
        if behavior.get("TargetOriginId") != "jeju-alb":
            check(f"No origin Host routing on {path}", not associations and not behavior.get("OriginRequestPolicyId"))
            continue
        check(f"Origin Host Lambda association matches mode on {path}",
              len(associations) == 1 and associations[0].get("EventType") == "origin-request"
              and associations[0].get("LambdaFunctionARN") == version
              and associations[0].get("IncludeBody", False) is False if canonical else not associations)
        policy = request_policy(behavior)
        headers = policy.get("HeadersConfig", {})
        forwarded = {name.lower() for name in headers.get("Headers", {}).get("Items", [])}
        if path == "/api/*":
            expected = {"origin", "content-type", "accept", "x-atlas-csrf"} | ({"host"} if canonical else set())
            check("Private API retains session proof, query strings and POST body forwarding",
                  headers.get("HeaderBehavior") == "whitelist" and forwarded == expected
                  and policy.get("CookiesConfig", {}).get("CookieBehavior") == "all"
                  and policy.get("QueryStringsConfig", {}).get("QueryStringBehavior") == "all"
                  and "POST" in behavior.get("AllowedMethods", {}).get("Items", [])
                  and behavior.get("CachePolicyId") == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad")
        elif canonical:
            check(f"Public Host forwarding excludes cookies and query strings on {path}",
                  headers.get("HeaderBehavior") == "whitelist" and forwarded == {"host"}
                  and policy.get("CookiesConfig", {}).get("CookieBehavior") == "none"
                  and policy.get("QueryStringsConfig", {}).get("QueryStringBehavior") == "none")
        else:
            check(f"Public origin request policy remains unchanged on {path}", not behavior.get("OriginRequestPolicyId"))


def verify():
    session = connect()
    cf = session.client("cloudformation")
    ec2 = session.client("ec2")
    ecs = session.client("ecs")
    elb = session.client("elbv2")
    edge = session.client("cloudfront")
    outputs = stack_outputs(cf, APP)
    image = load("image.json")
    settings = validate_settings(json.loads(SETTINGS.read_text()))
    checks = []

    def check(name, condition, detail=None):
        result = {"check": name, "passed": bool(condition)}
        if detail is not None:
            result["detail"] = detail
        checks.append(result)
        emit(result)

    assert_network(session)
    network = load("network.json")
    nat_ids = {s["defaultRoute"] for s in network["subnets"] if s["role"] == "private-ecs"}
    check("Existing NAT Gateways reused", nat_ids == {"nat-00b8a70dc184a4d0c", "nat-08379e076e2e6e234"}, sorted(nat_ids))

    stack = cf.describe_stacks(StackName=APP)["Stacks"][0]
    parameters = {item["ParameterKey"]: item["ParameterValue"] for item in stack.get("Parameters", [])}
    check("CloudFormation complete", stack["StackStatus"] in ["CREATE_COMPLETE", "UPDATE_COMPLETE"], stack["StackStatus"])
    resources = cf.list_stack_resources(StackName=APP)["StackResourceSummaries"]
    forbidden = {"AWS::EC2::VPC", "AWS::EC2::Subnet", "AWS::EC2::NatGateway", "AWS::EC2::EIP", "AWS::EC2::Route", "AWS::EC2::RouteTable"}
    check("No shared network resources created or managed", not any(r["ResourceType"] in forbidden for r in resources))

    service = ecs.describe_services(cluster=outputs["ClusterName"], services=[outputs["ServiceName"]])["services"][0]
    check("Service maintains the configured minimum capacity", service["desiredCount"] >= int(settings["MinTaskCount"]))
    check("Fargate service stable", service["runningCount"] == service["desiredCount"] and service["pendingCount"] == 0
          and all(d.get("rolloutState") == "COMPLETED" for d in service["deployments"]),
          {"desired": service["desiredCount"], "running": service["runningCount"], "pending": service["pendingCount"]})
    awsvpc = service["networkConfiguration"]["awsvpcConfiguration"]
    check("Private subnets and public IP disabled", set(awsvpc["subnets"]) == set(PRIVATE) and awsvpc["assignPublicIp"] == "DISABLED", awsvpc)
    taskdef = ecs.describe_task_definition(taskDefinition=service["taskDefinition"])["taskDefinition"]
    verify_task_configuration(taskdef, parameters, settings, image, check)
    container = next((item for item in taskdef["containerDefinitions"] if item.get("name") == "web"), {})
    check("Immutable image digest deployed", container.get("image") == image["imageUri"], container.get("image"))
    check("Nonroot and read-only container", container.get("user") == "1000:1000" and container.get("readonlyRootFilesystem") is True)
    task_role_name = taskdef["taskRoleArn"].split("/")[-1]
    iam = session.client("iam")
    environment = {item["name"]: item["value"] for item in container.get("environment", [])}
    check("Task IAM limited to selected catalog, guide and quota",
          task_iam_scoped(iam, task_role_name, environment, details_bucket=parameters.get("DetailsBucket", "")))
    check("Only catalog cache volume is writable", [
        mount["containerPath"] for mount in container.get("mountPoints", []) if not mount.get("readOnly", False)
    ] == ["/tmp"])
    check("Session secret injected without plaintext environment", "ATLAS_SESSION_SECRET" not in environment
          and any(item["name"] == "ATLAS_SESSION_SECRET" and item["valueFrom"].startswith("arn:aws:secretsmanager:")
                  for item in container.get("secrets", [])))
    kakao_parameter = parameters.get("KakaoRestApiKeyParameter", "")
    kakao_secrets = [item for item in container.get("secrets", []) if item["name"] == "KAKAO_REST_API_KEY"]
    expected_kakao_arn = f"arn:aws:ssm:{REGION}:{ACCOUNT}:parameter{kakao_parameter}" if kakao_parameter else ""
    check("Kakao credential is optional and injected only as a secret reference",
          "KAKAO_REST_API_KEY" not in environment and (
              kakao_secrets == [{"name": "KAKAO_REST_API_KEY", "valueFrom": expected_kakao_arn}]
              if kakao_parameter else not kakao_secrets))
    if kakao_parameter:
        check("Kakao has its own bounded provider budget",
              environment.get("KAKAO_DAILY_LIMIT") == parameters.get("KakaoDailyLimit")
              and 1 <= int(environment.get("KAKAO_DAILY_LIMIT", "0")) <= 1000)
        execution_role = taskdef["executionRoleArn"].split("/")[-1]
        ssm_resources = set()
        ssm_actions = set()
        for policy_name in iam.list_role_policies(RoleName=execution_role)["PolicyNames"]:
            policy = iam.get_role_policy(RoleName=execution_role, PolicyName=policy_name)["PolicyDocument"]
            for statement in policy.get("Statement", []):
                actions = statement.get("Action", [])
                if isinstance(actions, str):
                    actions = [actions]
                if statement.get("Effect") == "Allow" and any(action.startswith("ssm:") for action in actions):
                    ssm_actions.update(action for action in actions if action.startswith("ssm:"))
                    resources = statement.get("Resource", [])
                    ssm_resources.update([resources] if isinstance(resources, str) else resources)
        check("Execution role reads only the selected Kakao parameter",
              ssm_actions == {"ssm:GetParameters"} and ssm_resources == {expected_kakao_arn})
    check("Guide fleet limits configured", environment.get("GUIDE_DAILY_LIMIT") == settings["GuideDailyLimit"]
          and environment.get("GUIDE_HOURLY_LIMIT") == settings["GuideHourlyLimit"]
          and environment.get("GUIDE_GLOBAL_CONCURRENCY") == settings["GuideGlobalConcurrency"])
    check("Graceful shutdown precedes the ECS stop deadline", container.get("stopTimeout") == 120
          and 90_000 < int(environment.get("DRAIN_TIMEOUT_MS", "0")) < 120_000)

    task_arns = ecs.list_tasks(cluster=outputs["ClusterName"], serviceName=outputs["ServiceName"], desiredStatus="RUNNING")["taskArns"]
    tasks = ecs.describe_tasks(cluster=outputs["ClusterName"], tasks=task_arns)["tasks"] if task_arns else []
    check("Container health checks passing", bool(tasks) and all(t.get("healthStatus") == "HEALTHY" for t in tasks))
    check("Healthy tasks span two availability zones", len({
        task.get("availabilityZone") for task in tasks if task.get("healthStatus") == "HEALTHY"
    } - {None}) >= 2)
    eni_ids = [
        detail["value"] for task in tasks for attachment in task.get("attachments", [])
        for detail in attachment.get("details", []) if detail["name"] == "networkInterfaceId"
    ]
    enis = ec2.describe_network_interfaces(NetworkInterfaceIds=eni_ids)["NetworkInterfaces"] if eni_ids else []
    task_network = [
        {"eni": eni["NetworkInterfaceId"], "subnet": eni["SubnetId"], "privateIp": eni["PrivateIpAddress"],
         "hasPublicIp": bool(eni.get("Association", {}).get("PublicIp"))}
        for eni in enis
    ]
    check("Running ENIs are private", bool(enis) and all(eni["VpcId"] == VPC and eni["SubnetId"] in PRIVATE
          and not eni.get("Association", {}).get("PublicIp") for eni in enis), task_network)
    verify_routing_runtime(tasks, service, enis, outputs, image, check)

    alb = elb.describe_load_balancers(LoadBalancerArns=[outputs["LoadBalancerArn"]])["LoadBalancers"][0]
    check("ALB placed in public subnets", alb["Scheme"] == "internet-facing" and alb["VpcId"] == VPC
          and {s["SubnetId"] for s in alb["AvailabilityZones"]} == set(PUBLIC))
    targets = elb.describe_target_health(TargetGroupArn=outputs["TargetGroupArn"])["TargetHealthDescriptions"]
    check("ALB targets healthy", bool(targets) and all(t["TargetHealth"]["State"] == "healthy" for t in targets),
          [{"ip": t["Target"]["Id"], "port": t["Target"]["Port"], "state": t["TargetHealth"]["State"]} for t in targets])
    groups = ec2.describe_security_groups(GroupIds=[outputs["AlbSecurityGroupId"], outputs["TaskSecurityGroupId"]])["SecurityGroups"]
    alb_sg = next(g for g in groups if g["GroupId"] == outputs["AlbSecurityGroupId"])
    task_sg = next(g for g in groups if g["GroupId"] == outputs["TaskSecurityGroupId"])
    ingress = alb_sg["IpPermissions"]
    check("ALB ingress only CloudFront managed prefix TCP 80", len(ingress) == 1
          and ingress[0].get("FromPort") == 80 and ingress[0].get("ToPort") == 80
          and not ingress[0].get("IpRanges") and not ingress[0].get("Ipv6Ranges") and not ingress[0].get("UserIdGroupPairs")
          and [p["PrefixListId"] for p in ingress[0].get("PrefixListIds", [])] == [PREFIX])
    ingress = task_sg["IpPermissions"]
    check("Task ingress only ALB SG TCP 8080", len(ingress) == 1
          and ingress[0].get("FromPort") == 8080 and ingress[0].get("ToPort") == 8080
          and not ingress[0].get("IpRanges") and not ingress[0].get("Ipv6Ranges") and not ingress[0].get("PrefixListIds")
          and [g["GroupId"] for g in ingress[0].get("UserIdGroupPairs", [])] == [alb_sg["GroupId"]])
    egress = alb_sg["IpPermissionsEgress"]
    check("ALB egress only task SG TCP 8080", len(egress) == 1 and egress[0].get("FromPort") == 8080
          and egress[0].get("ToPort") == 8080 and not egress[0].get("IpRanges")
          and [g["GroupId"] for g in egress[0].get("UserIdGroupPairs", [])] == [task_sg["GroupId"]])

    distribution = edge.get_distribution(Id=outputs["DistributionId"])["Distribution"]
    check("CloudFront deployed", distribution["Status"] == "Deployed", distribution["Status"])
    config = distribution["DistributionConfig"]
    check("Confirmed custom domain and certificate are preserved",
          config.get("Aliases", {}).get("Items") == [settings["ViewerDomainName"]]
          and config.get("ViewerCertificate", {}).get("ACMCertificateArn") == settings["ViewerCertificateArn"])
    check("Dedicated WAF protects the distribution",
          "/webacl/jeju-3d-edge/" in config.get("WebACLId", ""))
    check("Viewers redirected to HTTPS", config["DefaultCacheBehavior"]["ViewerProtocolPolicy"] == "redirect-to-https")
    origin = next(item for item in config["Origins"]["Items"] if item["Id"] == "jeju-alb")
    verify_origin_routing(edge, config, parameters, settings, outputs, check)
    verify_media_delivery(edge, config, parameters, check)
    verify_assets_delivery(edge, config, parameters, check)
    terrain_origin = next((item for item in config["Origins"]["Items"] if item["Id"] == "jeju-terrain"), None)
    check("Terrain origin uses HTTPS and receives no ALB secret", bool(terrain_origin)
          and terrain_origin["DomainName"] == "elevation-tiles-prod.s3.us-east-1.amazonaws.com"
          and terrain_origin["CustomOriginConfig"]["OriginProtocolPolicy"] == "https-only"
          and terrain_origin.get("CustomHeaders", {}).get("Quantity", 0) == 0)
    terrain_behavior = next((item for item in config.get("CacheBehaviors", {}).get("Items", [])
                             if item["PathPattern"] == "/terrarium/*"), None)
    check("Elevation tile route bypasses the ALB", bool(terrain_behavior)
          and terrain_behavior["TargetOriginId"] == "jeju-terrain"
          and terrain_behavior["ViewerProtocolPolicy"] == "redirect-to-https"
          and set(terrain_behavior["AllowedMethods"]["Items"]) == {"GET", "HEAD"})
    if terrain_behavior:
        terrain_cache = edge.get_cache_policy(Id=terrain_behavior["CachePolicyId"])["CachePolicy"]["CachePolicyConfig"]
        cache_key = terrain_cache["ParametersInCacheKeyAndForwardedToOrigin"]
        check("Seven-day edge terrain cache shared across viewers", terrain_cache["DefaultTTL"] == 604800
              and terrain_cache["MinTTL"] == 0
              and cache_key["CookiesConfig"]["CookieBehavior"] == "none"
              and cache_key["HeadersConfig"]["HeaderBehavior"] == "none"
              and cache_key["QueryStringsConfig"]["QueryStringBehavior"] == "none")
    behaviors = config.get("CacheBehaviors", {}).get("Items", [])
    catalog_behavior = next((item for item in behaviors if item["PathPattern"] == "/api/catalog/*"), None)
    api_behavior = next((item for item in behaviors if item["PathPattern"] == "/api/*"), None)
    check("Private API never cached and supports POST", bool(api_behavior)
          and api_behavior["CachePolicyId"] == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
          and "POST" in api_behavior["AllowedMethods"]["Items"])
    if api_behavior:
        request_policy = edge.get_origin_request_policy(Id=api_behavior["OriginRequestPolicyId"])["OriginRequestPolicy"]["OriginRequestPolicyConfig"]
        check("Private API forwards the session-bound request proof",
              "x-atlas-csrf" in [value.lower() for value in request_policy["HeadersConfig"].get("Headers", {}).get("Items", [])])
    if catalog_behavior:
        policy = edge.get_cache_policy(Id=catalog_behavior["CachePolicyId"])["CachePolicy"]["CachePolicyConfig"]
        check("Public catalog cache does not forward cookies", policy["MinTTL"] == 0 and policy["DefaultTTL"] == 60
              and policy["ParametersInCacheKeyAndForwardedToOrigin"]["CookiesConfig"]["CookieBehavior"] == "none")
    else:
        check("Public catalog cache configured", False)
    listeners = elb.describe_listeners(LoadBalancerArn=outputs["LoadBalancerArn"])["Listeners"]
    listener = next(item for item in listeners if item["Port"] == 80)
    check("Unmatched ALB requests denied", listener["DefaultActions"][0]["Type"] == "fixed-response"
          and listener["DefaultActions"][0]["FixedResponseConfig"]["StatusCode"] == "403")
    rules = elb.describe_rules(ListenerArn=listener["ListenerArn"])["Rules"]
    rules = [r for r in rules if not r["IsDefault"]]
    # Values are compared only in memory, never included in reports or logs.
    header = next((h for h in origin["CustomHeaders"]["Items"] if h["HeaderName"].lower() == "x-jeju-origin-verify"), None)
    condition = next((c["HttpHeaderConfig"] for r in rules for c in r["Conditions"] if c["Field"] == "http-header"), None)
    check("CloudFront and ALB share the private origin verification value", bool(header and condition)
          and condition["HttpHeaderName"].lower() == header["HeaderName"].lower()
          and condition["Values"] == [header["HeaderValue"]] and len(header["HeaderValue"]) >= 32)
    del header, condition, config, rules, distribution

    url = outputs["ApplicationUrl"]
    root = requests.get(url + "/", timeout=30)
    check("Public HTTPS app responds", root.status_code == 200 and "제주" in root.text, {"status": root.status_code, "bytes": len(root.content)})
    check("CloudFront serves the response", "cloudfront" in root.headers.get("Via", "").lower() and bool(root.headers.get("X-Amz-Cf-Id")))
    check("Security headers present", root.headers.get("X-Content-Type-Options") == "nosniff"
          and root.headers.get("X-Frame-Options") == "DENY" and "max-age=31536000" in root.headers.get("Strict-Transport-Security", ""))
    redirect = requests.get(url.replace("https://", "http://") + "/", allow_redirects=False, timeout=20)
    check("HTTP redirects to HTTPS", redirect.status_code in [301, 302, 307, 308] and redirect.headers.get("Location", "").startswith(url))
    health = requests.get(url + "/healthz", timeout=30)
    health_data = health.json() if health.status_code == 200 else {}
    check("Live health reports the deployed release", health_data.get("status") == "ok" and health_data.get("release") == image["release"], health_data)
    check("Health is never cached", health.headers.get("Cache-Control") == "no-store")
    readiness = requests.get(url + "/readyz", timeout=30)
    check("Catalog readiness is healthy and never cached", readiness.status_code == 200
          and readiness.headers.get("Cache-Control") == "no-store")
    for host in dict.fromkeys([f"https://{settings['ViewerDomainName']}", outputs.get("CloudFrontUrl", url)]):
        browser = requests.Session()
        configuration = browser.get(host + "/api/config", timeout=30)
        proof = configuration.json().get("guide", {}).get("csrf_token", "")
        validation = browser.post(host + "/api/guide", json={"message": "", "locale": "en"},
                                  headers={"Origin": host, "X-Atlas-CSRF": proof}, timeout=20)
        check("Both served origins accept the app proof before model invocation",
              configuration.status_code == 200 and validation.status_code == 400
              and validation.json().get("error", {}).get("code") == "invalid_message", {"host": host})
    asset = re.search(r'src="(/assets/[^"]+\.js)"', root.text)
    if asset:
        asset_url = url + asset.group(1)
        requests.get(asset_url, timeout=30)
        cached = requests.get(asset_url, timeout=30)
        check("Versioned assets served from CloudFront cache", cached.status_code == 200
              and "Hit from cloudfront" in cached.headers.get("X-Cache", ""),
              {"asset": asset.group(1), "cache": cached.headers.get("X-Cache"), "age": cached.headers.get("Age")})
    else:
        check("Versioned assets present", False)
    missing = requests.get(url + "/assets/does-not-exist.js", timeout=30)
    if parameters.get("AssetsBucketDomainName"):
        # S3 intentionally returns 403 for absent keys without ListBucket.
        # The OAC receives GetObject only; do not add listing permission merely
        # to expose object existence or turn errors into a successful app shell.
        check("Missing shared asset is denied without exposing a bucket listing",
              missing.status_code == 403 and "AccessDenied" in missing.text)
        missing_page = requests.get(url + "/does-not-exist.js", timeout=30)
        check("Missing ALB static path still returns 404", missing_page.status_code == 404)
    else:
        check("Missing asset returns 404", missing.status_code == 404)
    catalog_response = requests.get(url + "/api/catalog/status", timeout=30)
    catalog_data = catalog_response.json() if catalog_response.status_code == 200 else {}
    check("Live service catalog includes enriched and OSM data", catalog_data.get("total", 0) >= 6000
          and catalog_data.get("by_source", {}).get("OpenStreetMap", 0) >= 6000
          and catalog_data.get("by_source", {}).get("sample", 0) >= 130,
          {"total": catalog_data.get("total"), "bySource": catalog_data.get("by_source")})
    check("Public catalog has no session cookie", not catalog_response.headers.get("Set-Cookie"))
    client = requests.Session()
    api_config = client.get(url + "/api/config", timeout=30)
    api_data = api_config.json() if api_config.status_code == 200 else {}
    check("Private config enables bounded guide without caching", api_config.status_code == 200
          and api_config.headers.get("Cache-Control") == "no-store"
          and api_data.get("guide", {}).get("daily_limit") == 30)
    cookie_header = api_config.headers.get("Set-Cookie", "").lower()
    check("Session cookie is HttpOnly and Secure", "httponly" in cookie_header and "secure" in cookie_header and "samesite=lax" in cookie_header)
    csrf_token = api_data.get("guide", {}).get("csrf_token", "")
    check("Private config returns a bounded session-bound request proof",
          isinstance(csrf_token, str) and bool(re.fullmatch(r"[A-Za-z0-9_-]{43}", csrf_token)))
    rejected = client.post(url + "/api/guide", json={"message": "이 요청은 실행되지 않아야 합니다."},
                           headers={"Origin": "https://example.com"}, timeout=20)
    check("Foreign-origin guide requests rejected", rejected.status_code == 403)
    # Empty messages stop at validation, before quota or model invocation.
    proof_request = client.post(url + "/api/guide", json={"message": ""},
                                headers={"Origin": "null", "X-Atlas-CSRF": csrf_token}, timeout=20)
    check("Verified app requests tolerate a missing browser origin without a model call",
          proof_request.status_code == 400 and proof_request.json().get("error", {}).get("code") == "invalid_message")
    forged_proof = client.post(url + "/api/guide", json={"message": ""},
                               headers={"Origin": "null", "X-Atlas-CSRF": "forged"}, timeout=20)
    check("Forged app request proofs are rejected",
          forged_proof.status_code == 403 and forged_proof.json().get("error", {}).get("code") == "csrf_invalid")
    worker = requests.get(url + "/sw.js", timeout=20)
    check("PWA worker revalidates", worker.status_code == 200 and "no-cache" in worker.headers.get("Cache-Control", ""))

    try:
        direct = requests.get("http://" + outputs["LoadBalancerDnsName"] + "/", timeout=6)
        check("Direct public ALB bypass blocked", direct.status_code == 403, {"status": direct.status_code})
    except requests.exceptions.ConnectTimeout:
        check("Direct public ALB bypass blocked", True, "TCP connection timed out as expected for a non-CloudFront source")
    except requests.exceptions.ConnectionError as error:
        check("Direct public ALB bypass blocked", False, {"error": type(error).__name__, "message": "Network failure is inconclusive; inspect connectivity"})

    report = {
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "account": ACCOUNT,
        "url": url,
        "release": image["release"],
        "checks": checks,
        "passed": all(item["passed"] for item in checks),
        "taskNetwork": task_network,
        "network": network,
    }
    save("verification.json", report)
    emit({"passed": report["passed"], "count": len(checks), "report": str(LOCAL / "verification.json")})
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(verify())
