#!/usr/bin/env python3
"""Verify the deployed Jeju app, network placement and origin restrictions."""
from __future__ import annotations

from datetime import datetime, timezone
import json
import re
import sys

import requests
from deploy import ACCOUNT, APP, LOCAL, PREFIX, PRIVATE, PUBLIC, VPC, assert_network, connect, emit, load, save, stack_outputs


def verify():
    session = connect()
    cf = session.client("cloudformation")
    ec2 = session.client("ec2")
    ecs = session.client("ecs")
    elb = session.client("elbv2")
    edge = session.client("cloudfront")
    outputs = stack_outputs(cf, APP)
    image = load("image.json")
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
    check("CloudFormation complete", stack["StackStatus"] in ["CREATE_COMPLETE", "UPDATE_COMPLETE"], stack["StackStatus"])
    resources = cf.list_stack_resources(StackName=APP)["StackResourceSummaries"]
    forbidden = {"AWS::EC2::VPC", "AWS::EC2::Subnet", "AWS::EC2::NatGateway", "AWS::EC2::EIP", "AWS::EC2::Route", "AWS::EC2::RouteTable"}
    check("No shared network resources created or managed", not any(r["ResourceType"] in forbidden for r in resources))

    service = ecs.describe_services(cluster=outputs["ClusterName"], services=[outputs["ServiceName"]])["services"][0]
    check("Fargate service stable", service["runningCount"] == service["desiredCount"] and service["pendingCount"] == 0
          and all(d.get("rolloutState") == "COMPLETED" for d in service["deployments"]),
          {"desired": service["desiredCount"], "running": service["runningCount"], "pending": service["pendingCount"]})
    awsvpc = service["networkConfiguration"]["awsvpcConfiguration"]
    check("Private subnets and public IP disabled", set(awsvpc["subnets"]) == set(PRIVATE) and awsvpc["assignPublicIp"] == "DISABLED", awsvpc)
    taskdef = ecs.describe_task_definition(taskDefinition=service["taskDefinition"])["taskDefinition"]
    container = taskdef["containerDefinitions"][0]
    check("ARM64 0.25 vCPU 512 MiB", taskdef["runtimePlatform"]["cpuArchitecture"] == "ARM64"
          and taskdef["cpu"] == "256" and taskdef["memory"] == "512")
    check("Immutable image digest deployed", container["image"] == image["imageUri"], container["image"])
    check("Nonroot and read-only container", container.get("user") == "1000:1000" and container.get("readonlyRootFilesystem") is True)
    task_role_name = taskdef["taskRoleArn"].split("/")[-1]
    iam = session.client("iam")
    attached = iam.list_attached_role_policies(RoleName=task_role_name)["AttachedPolicies"]
    inline = iam.list_role_policies(RoleName=task_role_name)["PolicyNames"]
    check("Application task has no AWS policies", not attached and not inline)

    task_arns = ecs.list_tasks(cluster=outputs["ClusterName"], serviceName=outputs["ServiceName"], desiredStatus="RUNNING")["taskArns"]
    tasks = ecs.describe_tasks(cluster=outputs["ClusterName"], tasks=task_arns)["tasks"] if task_arns else []
    check("Container health checks passing", bool(tasks) and all(t.get("healthStatus") == "HEALTHY" for t in tasks))
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
    check("Viewers redirected to HTTPS", config["DefaultCacheBehavior"]["ViewerProtocolPolicy"] == "redirect-to-https")
    origin = config["Origins"]["Items"][0]
    check("CloudFront origin is this ALB", origin["DomainName"] == outputs["LoadBalancerDnsName"])
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
    check("Missing asset returns 404", missing.status_code == 404)

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
