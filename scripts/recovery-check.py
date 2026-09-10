#!/usr/bin/env python3
"""Observe app recovery; --replace-one permits exactly one guarded ECS StopTask."""
from __future__ import annotations

import sys
sys.dont_write_bytecode = True

import argparse
from collections import Counter
import importlib.util
import json
from pathlib import Path
import threading
import time

# Share GET validation/reporting. Importing this module performs no requests.
_spec = importlib.util.spec_from_file_location("atlas_load_check", Path(__file__).with_name("load-check.py"))
_http = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_http)

ACCOUNT = "061525506239"
REGION = "ap-northeast-2"
APP_STACK = "Jeju3dApp"
APP_NAME = "jeju-3d"
ECS_PREFIX = f"arn:aws:ecs:{REGION}:{ACCOUNT}:"
SERVICE_ARN = ECS_PREFIX + "service/jeju-3d/jeju-3d"
CLUSTER_ARN = ECS_PREFIX + "cluster/jeju-3d"
ELB_PREFIX = f"arn:aws:elasticloadbalancing:{REGION}:{ACCOUNT}:"
REQUIRED_OUTPUTS = ("ApplicationUrl", "ClusterName", "ServiceName", "LoadBalancerArn",
                    "TargetGroupArn", "TaskDefinitionArn")


class Refused(Exception):
    """Fixed safe reason codes only; never attach an AWS response or body."""


def require(condition, code):
    if not condition:
        raise Refused(code)


def aws_clients():
    import boto3
    from botocore.config import Config
    config = Config(region_name=REGION, connect_timeout=3, read_timeout=5,
                    retries={"total_max_attempts": 1, "mode": "standard"})
    session = boto3.Session(region_name=REGION)
    return {name: session.client(service, config=config)
            for name, service in [("sts", "sts"), ("cf", "cloudformation"),
                                  ("ecs", "ecs"), ("elb", "elbv2")]}


def project_tags(value):
    return any(tag.get("key") == "Project" and tag.get("value") == APP_NAME
               for tag in value.get("tags", []))


def task_ip(task):
    for attachment in task.get("attachments", []):
        if attachment.get("type") == "ElasticNetworkInterface":
            for detail in attachment.get("details", []):
                if detail.get("name") == "privateIPv4Address":
                    return detail.get("value")
    for container in task.get("containers", []):
        for interface in container.get("networkInterfaces", []):
            if interface.get("privateIpv4Address"):
                return interface["privateIpv4Address"]
    return None


def inspect_service(clients, outputs):
    ecs, elb = clients["ecs"], clients["elb"]
    response = ecs.describe_services(cluster=APP_NAME, services=[APP_NAME], include=["TAGS"])
    require(not response.get("failures") and len(response.get("services", [])) == 1, "service_unavailable")
    service = response["services"][0]
    require(service.get("serviceArn") == SERVICE_ARN and service.get("clusterArn") == CLUSTER_ARN
            and service.get("serviceName") == APP_NAME and service.get("status") == "ACTIVE"
            and service.get("launchType") == "FARGATE" and project_tags(service), "service_not_owned")
    require(service.get("taskDefinition") == outputs["TaskDefinitionArn"], "task_definition_changed")
    require(service.get("deploymentController", {}).get("type", "ECS") == "ECS", "unexpected_deployment_controller")
    mappings = service.get("loadBalancers", [])
    require(len(mappings) == 1 and mappings[0].get("targetGroupArn") == outputs["TargetGroupArn"]
            and mappings[0].get("containerName") == "web" and mappings[0].get("containerPort") == 8080,
            "target_group_not_owned")
    listed = ecs.list_tasks(cluster=APP_NAME, serviceName=APP_NAME, desiredStatus="RUNNING", maxResults=100)
    require(not listed.get("nextToken"), "task_inspection_limit")
    arns = listed.get("taskArns", [])
    require(len(arns) == len(set(arns)) and all(isinstance(arn, str) and
            arn.startswith(ECS_PREFIX + "task/jeju-3d/") for arn in arns), "task_not_owned")
    described = ecs.describe_tasks(cluster=APP_NAME, tasks=arns, include=["TAGS"]) if arns else {"tasks": []}
    require(not described.get("failures"), "task_inspection_failed")
    tasks = described.get("tasks", [])
    require({task.get("taskArn") for task in tasks} == set(arns), "task_inspection_incomplete")
    for task in tasks:
        require(task.get("clusterArn") == CLUSTER_ARN and task.get("group") == "service:jeju-3d"
                and task.get("taskDefinitionArn") == outputs["TaskDefinitionArn"] and project_tags(task),
                "task_not_owned")
    healthy = [
        task for task in tasks if task.get("lastStatus") == task.get("desiredStatus") == "RUNNING"
        and task.get("healthStatus") == "HEALTHY" and task_ip(task)
        and isinstance(task.get("availabilityZone"), str) and task["availabilityZone"].startswith(REGION)
    ]
    targets = elb.describe_target_health(TargetGroupArn=outputs["TargetGroupArn"])["TargetHealthDescriptions"]
    healthy_addresses = {
        entry["Target"]["Id"] for entry in targets
        if entry.get("TargetHealth", {}).get("State") == "healthy"
        and entry.get("Target", {}).get("Port") == 8080
    }
    eligible = [task for task in healthy if task_ip(task) in healthy_addresses]
    owned_healthy_targets = len({task_ip(task) for task in eligible})
    issues = []
    if service.get("desiredCount", 0) < 2 or service.get("runningCount", 0) < 2:
        issues.append("fewer_than_two_running_tasks")
    deployments = service.get("deployments", [])
    if (service.get("pendingCount") != 0 or service.get("runningCount") != service.get("desiredCount")
            or len(tasks) != service.get("runningCount")
            or len(deployments) != 1 or deployments[0].get("status") != "PRIMARY"
            or deployments[0].get("rolloutState") != "COMPLETED"
            or deployments[0].get("pendingCount") != 0):
        issues.append("deployment_or_replacement_in_progress")
    if len(healthy) < 2:
        issues.append("fewer_than_two_healthy_tasks")
    if owned_healthy_targets < 2:
        issues.append("fewer_than_two_owned_healthy_targets")
    if len({task["availabilityZone"] for task in eligible}) < 2:
        issues.append("healthy_tasks_not_spread_across_azs")
    return {
        "desired": service.get("desiredCount"), "running": service.get("runningCount"),
        "pending": service.get("pendingCount"), "healthy_targets": owned_healthy_targets,
        "running_task_arns": sorted(arns),
        "tasks": [{"task_arn": task["taskArn"], "az": task["availabilityZone"]} for task in eligible],
        "stable": not issues, "issues": issues,
    }


def preflight(clients, url, saved_outputs=None, *, require_healthy=True):
    base = _http.canonical_url(url)
    require(all(client.meta.region_name == REGION for client in clients.values()), "wrong_region")
    require(clients["sts"].get_caller_identity().get("Account") == ACCOUNT, "wrong_account")
    stacks = clients["cf"].describe_stacks(StackName=APP_STACK).get("Stacks", [])
    require(len(stacks) == 1, "app_stack_missing")
    stack = stacks[0]
    require(stack.get("StackId", "").startswith(
        f"arn:aws:cloudformation:{REGION}:{ACCOUNT}:stack/{APP_STACK}/"), "stack_not_owned")
    require(stack.get("StackStatus") in {"CREATE_COMPLETE", "UPDATE_COMPLETE"}, "stack_not_stable")
    outputs = {item["OutputKey"]: item["OutputValue"] for item in stack.get("Outputs", [])}
    require(all(isinstance(outputs.get(key), str) and outputs[key] for key in REQUIRED_OUTPUTS),
            "app_outputs_incomplete")
    require(outputs["ClusterName"] == outputs["ServiceName"] == APP_NAME, "unexpected_cluster_or_service")
    allowed_urls = {_http.canonical_url(outputs[key]) for key in ("ApplicationUrl", "CloudFrontUrl") if outputs.get(key)}
    require(base in allowed_urls, "url_does_not_match_app_outputs")
    if saved_outputs is not None:
        require(isinstance(saved_outputs, dict)
                and all(saved_outputs.get(key) == outputs[key] for key in REQUIRED_OUTPUTS),
                "saved_outputs_do_not_match")
        if "CloudFrontUrl" in saved_outputs:
            require(saved_outputs["CloudFrontUrl"] == outputs.get("CloudFrontUrl"), "saved_outputs_do_not_match")
    require(outputs["LoadBalancerArn"].startswith(ELB_PREFIX + "loadbalancer/app/jeju-3d-alb/")
            and outputs["TargetGroupArn"].startswith(ELB_PREFIX + "targetgroup/jeju-3d-tasks/")
            and outputs["TaskDefinitionArn"].startswith(ECS_PREFIX + "task-definition/jeju-3d:"),
            "resource_arns_do_not_match_app")
    for logical_id, expected in [("Service", SERVICE_ARN), ("LoadBalancer", outputs["LoadBalancerArn"]),
                                 ("TargetGroup", outputs["TargetGroupArn"])]:
        physical = clients["cf"].describe_stack_resource(StackName=APP_STACK, LogicalResourceId=logical_id)
        require(physical["StackResourceDetail"]["PhysicalResourceId"] == expected, "stack_resource_mismatch")
    groups = clients["elb"].describe_target_groups(TargetGroupArns=[outputs["TargetGroupArn"]])["TargetGroups"]
    require(len(groups) == 1 and groups[0].get("TargetGroupArn") == outputs["TargetGroupArn"]
            and groups[0].get("TargetType") == "ip" and groups[0].get("Port") == 8080
            and groups[0].get("LoadBalancerArns") == [outputs["LoadBalancerArn"]], "load_balancer_mismatch")
    snapshot = inspect_service(clients, outputs)
    if require_healthy:
        require(snapshot["stable"], snapshot["issues"][0] if snapshot["issues"] else "service_not_stable")
    return {"url": base, "outputs": outputs, "baseline": snapshot, "_stop_attempted": False}


def request_replacement(clients, target, *, deadline=None):
    require(not target.get("_stop_attempted"), "replacement_already_attempted")
    fresh = preflight(clients, target["url"], saved_outputs=target["outputs"])
    snapshot = fresh["baseline"]
    target["baseline"] = snapshot
    zones = Counter(task["az"] for task in snapshot["tasks"])
    selected = sorted(snapshot["tasks"], key=lambda task: (-zones[task["az"]], task["task_arn"]))[0]
    require(deadline is None or time.monotonic() < deadline, "observation_window_expired")
    target["_stop_attempted"] = True
    result = {"attempted": True, "task_arn": selected["task_arn"], "outcome": "unknown"}
    target["_stop_result"] = result
    try:
        response = clients["ecs"].stop_task(
            cluster=APP_NAME, task=selected["task_arn"],
            reason="Operator-requested Jeju Atlas single-task recovery check",
        )
        if response.get("task", {}).get("taskArn") == selected["task_arn"]:
            result["outcome"] = "accepted"
    except Exception:
        # The remote call may have succeeded. Never retry it or select another task.
        pass
    return result


def run_recovery(url, *, clients, duration=300, replace_one=False, saved_outputs=None,
                 session_factory=_http.requests.Session, progress=lambda event: None):
    if type(duration) is not int or not 1 <= duration <= 300:
        raise ValueError("duration must be an integer from 1 to 300 seconds")
    report = {
        "kind": "recovery", "started_at": _http.utc_now(), "passed": False,
        "mode": "replace-one" if replace_one else "observe",
        "monitor_limit_seconds": duration, "request_timeout_seconds": _http.HTTP_TIMEOUT,
        "stop": {"attempted": False, "task_arn": None, "outcome": "not_requested"},
        "service_recovered": False, "replacement_observed": False,
    }
    samples = []
    sample_lock = threading.Lock()
    stop = threading.Event()
    observer_ready = threading.Event()
    thread = None
    joined = False
    target = None
    begun = time.monotonic()
    try:
        target = preflight(clients, url, saved_outputs, require_healthy=replace_one)
        report.update(target=target["url"], account=ACCOUNT, region=REGION, stack=APP_STACK,
                      baseline=target["baseline"])
        with session_factory() as session:
            health = _http.probe(session, target["url"], _http.HEALTH)
            samples.append(health)
            if replace_one:
                require(not health["error"], "http_health_preflight_failed")
            release = health.get("release")
            report["release"] = release
            config = _http.probe(session, target["url"], _http.CONFIG, release)
            samples.append(config)
            if replace_one:
                require(not config["error"], "http_config_preflight_failed")
        monitored = time.monotonic()
        deadline = monitored + duration

        def observe_http():
            nonlocal release
            # AWS polling must not leave gaps in HTTP failover observation.
            try:
                with session_factory() as session:
                    next_round = time.monotonic()
                    while not stop.is_set() and time.monotonic() < deadline:
                        for route in (_http.HEALTH, _http.CONFIG):
                            remaining = deadline - time.monotonic()
                            if stop.is_set() or remaining <= 0:
                                return
                            sample = _http.probe(session, target["url"], route, release,
                                                 timeout=min(_http.HTTP_TIMEOUT, remaining))
                            with sample_lock:
                                if route == _http.HEALTH and not sample["error"] and release is None:
                                    release = sample["release"]
                                    report["release"] = release
                                samples.append(sample)
                        observer_ready.set()
                        next_round = max(next_round + 1, time.monotonic())
                        stop.wait(max(0, min(next_round - time.monotonic(), deadline - time.monotonic())))
            except Exception:
                with sample_lock:
                    samples.append({"route": "monitor", "status": 0, "error": "monitor_failed", "elapsed_ms": 0})
                stop.set()
            finally:
                observer_ready.set()

        thread = threading.Thread(target=observe_http, name="recovery-http-probes", daemon=True)
        thread.start()
        if replace_one:
            require(observer_ready.wait(timeout=min(_http.HTTP_TIMEOUT, duration)), "observer_start_timeout")
            with sample_lock:
                require(not stop.is_set() and not any(sample["error"] for sample in samples),
                        "http_monitor_not_ready")
            report["stop"] = request_replacement(clients, target, deadline=deadline)
            report["baseline"] = target["baseline"]
        next_state, next_progress = monitored, monitored + 30
        baseline_arns = {task["task_arn"] for task in target["baseline"]["tasks"]}
        latest = target["baseline"]
        while not stop.is_set() and time.monotonic() < deadline:
            now = time.monotonic()
            if now >= next_state:
                try:
                    latest = inspect_service(clients, target["outputs"])
                    report.pop("service_check_error", None)
                except Exception:
                    report["service_check_error"] = "service_state_unavailable"
                    latest = {**latest, "stable": False}
                next_state = time.monotonic() + 5
                current_arns = {task["task_arn"] for task in latest["tasks"]}
                replaced = (replace_one and report["stop"]["task_arn"] not in latest["running_task_arns"]
                            and bool(current_arns - baseline_arns))
                if replaced and latest["stable"]:
                    report["replacement_observed"] = True
                    report["recovery_seconds"] = round(time.monotonic() - monitored, 3)
                    break
            if now >= next_progress:
                with sample_lock:
                    errors = sum(sample["error"] is not None for sample in samples)
                progress({"phase": "recovery", "elapsed_seconds": round(now - monitored, 1),
                          "http_errors": errors, "healthy_targets": latest["healthy_targets"],
                          "service_stable": latest["stable"]})
                next_progress = now + 30
            stop.wait(min(1, max(0, deadline - time.monotonic())))
        report["monitor_seconds"] = round(time.monotonic() - monitored, 3)
        stop.set()
        thread.join(timeout=_http.HTTP_TIMEOUT + 1)
        joined = True
        require(not thread.is_alive(), "http_probe_did_not_finish")
        # Always check the public path again after observation/replacement.
        with session_factory() as session:
            health = _http.probe(session, target["url"], _http.HEALTH, release)
            samples.append(health)
            if not health["error"] and release is None:
                release = health["release"]
                report["release"] = release
            samples.append(_http.probe(session, target["url"], _http.CONFIG, release))
        final = inspect_service(clients, target["outputs"])
        report["final"] = final
        report["service_recovered"] = final["stable"]
        if replace_one:
            arns = {task["task_arn"] for task in final["tasks"]}
            report["replacement_observed"] = (report["stop"]["task_arn"] not in final["running_task_arns"]
                                               and bool(arns - baseline_arns))
        report["passed"] = (release is not None and final["stable"] and not any(sample["error"] for sample in samples)
                            and (not replace_one or report["replacement_observed"]))
    except Refused as error:
        report["error"] = str(error)
    except KeyboardInterrupt:
        report["error"] = "interrupted"
    except Exception:
        report["error"] = "recovery_check_failed"
    finally:
        stop.set()
        if target is not None and target.get("_stop_result"):
            report["stop"] = target["_stop_result"]
            report["baseline"] = target["baseline"]
        if not joined and thread is not None and thread.is_alive():
            thread.join(timeout=_http.HTTP_TIMEOUT + 1)
        with sample_lock:
            report["http"] = _http.summarize(list(samples), time.monotonic() - begun)
        report["finished_at"] = _http.utc_now()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", help="Must match deployed ApplicationUrl or CloudFrontUrl")
    parser.add_argument("--output", "-o", required=True, type=Path, help="Explicit JSON report, e.g. .local/recovery.json")
    parser.add_argument("--duration", type=int, default=300, help="Monitoring window, 1..300 seconds")
    parser.add_argument("--outputs", type=Path, help="Optional saved app outputs to compare with deployed outputs")
    parser.add_argument("--replace-one", action="store_true", help="Authorize one owned healthy task replacement after preflight")
    args = parser.parse_args()
    try:
        # Validate arguments before credential resolution or AWS reads.
        _http.canonical_url(args.url)
        if not 1 <= args.duration <= 300:
            raise ValueError()
        saved = json.loads(args.outputs.read_text()) if args.outputs else None
        report = run_recovery(args.url, clients=aws_clients(), duration=args.duration,
                              replace_one=args.replace_one, saved_outputs=saved,
                              progress=lambda event: print(json.dumps(event), flush=True))
    except Exception:
        report = {"kind": "recovery", "passed": False, "error": "invalid_arguments_or_preflight_failure",
                  "stop": {"attempted": False, "task_arn": None, "outcome": "not_requested"}}
    _http.write_report(args.output, report)
    print(json.dumps({"report": str(args.output), "passed": report["passed"],
                      "stop": report["stop"], "http_errors": report.get("http", {}).get("errors")}))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
