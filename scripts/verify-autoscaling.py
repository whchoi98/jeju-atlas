#!/usr/bin/env python3
"""Exercise the existing target tracker inside its deployed 2..4 task bound.

Requires --execute for the temporary memory target change. Restores the saved
policy in finally; if automatic scale-in does not finish, restores baseline
capacity explicitly and reports that distinction. Never invokes a model.
"""
from __future__ import annotations
import argparse
import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import signal
import time

import requests
from botocore.config import Config
from deploy import connect, APP, stack_outputs

RESOURCE = "service/jeju-3d/jeju-3d"
POLICY = "jeju-3d-memory"
KEY = {"ServiceNamespace": "ecs", "ResourceId": RESOURCE, "ScalableDimension": "ecs:service:DesiredCount"}
RESTORE_ATTEMPTS = 3
RESTORE_DELAY = 2
ACTIVITY_ATTEMPTS = 3
ACTIVITY_DELAY = 5


def validate_preflight(service, target, policy):
    if service.get("serviceName") != "jeju-3d" or service.get("desiredCount") != 2:
        raise RuntimeError("Expected the owned service at its baseline of two tasks")
    if service.get("runningCount") != 2 or service.get("pendingCount") != 0:
        raise RuntimeError("Service is not at stable baseline capacity")
    deployments = service.get("deployments", [])
    if len(deployments) != 1 or deployments[0].get("rolloutState") != "COMPLETED":
        raise RuntimeError("A deployment is active")
    if target.get("MinCapacity") != 2 or target.get("MaxCapacity") != 4:
        raise RuntimeError("The existing two-to-four task boundary must be preserved")
    if policy.get("PolicyName") != POLICY or policy.get("PolicyType") != "TargetTrackingScaling":
        raise RuntimeError("Unexpected scaling policy")
    config = policy.get("TargetTrackingScalingPolicyConfiguration", {})
    if config.get("TargetValue") != 70 or config.get("PredefinedMetricSpecification", {}).get("PredefinedMetricType") != "ECSServiceAverageMemoryUtilization":
        raise RuntimeError("Expected the deployed memory policy at 70 percent")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    session = connect()
    # Cleanup owns retries so neither SDK retries nor network waits are unbounded.
    config = Config(connect_timeout=3, read_timeout=10, retries={"total_max_attempts": 1, "mode": "standard"})
    ecs = session.client("ecs", config=config)
    scaling = session.client("application-autoscaling", config=config)
    elb = session.client("elbv2", config=config)
    cf = session.client("cloudformation", config=config)
    if cf.describe_stacks(StackName=APP)["Stacks"][0]["StackStatus"] != "UPDATE_COMPLETE":
        raise RuntimeError("Application stack must be stable")
    outputs = stack_outputs(cf, APP)
    if outputs["ClusterName"] != "jeju-3d" or outputs["ServiceName"] != "jeju-3d":
        raise RuntimeError("Unexpected application identity")

    def service():
        return ecs.describe_services(cluster="jeju-3d", services=["jeju-3d"])["services"][0]

    target = scaling.describe_scalable_targets(
        ServiceNamespace="ecs", ResourceIds=[RESOURCE], ScalableDimension=KEY["ScalableDimension"],
    )["ScalableTargets"][0]
    policy = next(p for p in scaling.describe_scaling_policies(**KEY)["ScalingPolicies"] if p["PolicyName"] == POLICY)
    baseline = service()
    validate_preflight(baseline, target, policy)
    original = copy.deepcopy(policy["TargetTrackingScalingPolicyConfiguration"])
    report = {
        "startedAt": datetime.now(timezone.utc).isoformat(), "mode": "execute" if args.execute else "preview",
        "policyName": POLICY, "originalPolicy": original, "temporaryTargetValue": 1,
        "minCapacity": 2, "maxCapacity": 4, "baselineTaskDefinition": baseline["taskDefinition"],
        "httpChecks": 0, "httpErrors": 0, "samples": [],
        "reachedMaxCapacity": False, "scalingActivities": [],
        "automaticScaleOut": False, "automaticScaleIn": False, "policyRestored": False,
        "baselineRestored": False, "passed": False,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)

    def save():
        args.output.write_text(json.dumps(report, ensure_ascii=False, default=str, indent=2) + "\n")

    save()
    if not args.execute:
        print(json.dumps({"preview": True, "output": str(args.output), "change": "Memory target 70 -> 1 -> 70, capacity bound remains 2..4"}))
        return

    cleaning_up = False

    def interrupted(signum, frame):
        report["interrupted"] = True
        if not cleaning_up:
            raise InterruptedError(f"Interrupted by signal {signum}")

    previous_handlers = {signum: signal.signal(signum, interrupted) for signum in (signal.SIGTERM, signal.SIGINT)}
    started = time.monotonic()
    started_at = datetime.now(timezone.utc)
    changed = False
    original_alarm_names = {alarm["AlarmName"] for alarm in policy.get("Alarms", [])}
    scale_out_alarm_names = original_alarm_names

    def same_deployment(current):
        deployments = current.get("deployments", [])
        return (current.get("serviceName") == "jeju-3d"
                and current.get("taskDefinition") == baseline["taskDefinition"]
                and 2 <= current.get("desiredCount", 0) <= 4
                and len(deployments) == 1 and deployments[0].get("rolloutState") == "COMPLETED"
                and deployments[0].get("id") == baseline["deployments"][0].get("id"))

    def observe(desired, seconds, phase):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            current = service()
            if not same_deployment(current):
                raise RuntimeError("Concurrent deployment or capacity change detected")
            health = elb.describe_target_health(TargetGroupArn=outputs["TargetGroupArn"])["TargetHealthDescriptions"]
            healthy = sum(item["TargetHealth"]["State"] == "healthy" for item in health)
            try:
                response = requests.get(outputs["ApplicationUrl"] + "/healthz", timeout=10)
                ok = response.status_code == 200 and response.json().get("service") == "jeju-3d"
            except (requests.RequestException, ValueError):
                ok = False
            report["httpChecks"] += 1
            report["httpErrors"] += not ok
            point = {
                "phase": phase, "elapsedSeconds": round(time.monotonic() - started, 1),
                "desired": current["desiredCount"], "running": current["runningCount"],
                "pending": current["pendingCount"], "healthyTargets": healthy, "httpOk": ok,
            }
            report["samples"].append(point)
            print(json.dumps(point), flush=True)
            save()
            if current["desiredCount"] == desired and current["runningCount"] == desired and not current["pendingCount"] and healthy == desired:
                return True
            time.sleep(10)
        return False

    def cleanup_error(phase, error, attempt=None):
        item = {"phase": phase, "type": type(error).__name__}
        if attempt is not None:
            item["attempt"] = attempt
        report.setdefault("cleanupErrors", []).append(item)

    def restore_policy():
        for attempt in range(1, RESTORE_ATTEMPTS + 1):
            report["policyRestoreAttempts"] = attempt
            try:
                scaling.put_scaling_policy(**KEY, PolicyName=POLICY, PolicyType="TargetTrackingScaling",
                                           TargetTrackingScalingPolicyConfiguration=original)
            except Exception as error:
                cleanup_error("policy-write", error, attempt)
            # A failed response may still have committed; always read back.
            try:
                current = next(p for p in scaling.describe_scaling_policies(**KEY)["ScalingPolicies"]
                               if p["PolicyName"] == POLICY)
                if current["TargetTrackingScalingPolicyConfiguration"] == original:
                    return True
                cleanup_error("policy-read", RuntimeError("Policy differs from baseline"), attempt)
            except Exception as error:
                cleanup_error("policy-read", error, attempt)
            if attempt < RESTORE_ATTEMPTS:
                time.sleep(RESTORE_DELAY)
        return False

    def restore_capacity():
        def guarded_service():
            current = service()
            if not same_deployment(current):
                report["capacityRestoreBlocked"] = "concurrent_deployment_or_capacity_change"
                return None
            return current

        for attempt in range(1, RESTORE_ATTEMPTS + 1):
            report["capacityRestoreAttempts"] = attempt
            try:
                current = guarded_service()
                if current is None:
                    return False
                if current["desiredCount"] != 2:
                    report["manualCapacityRestore"] = True
                    ecs.update_service(cluster="jeju-3d", service="jeju-3d", desiredCount=2)
            except Exception as error:
                cleanup_error("capacity-write", error, attempt)
            try:
                current = guarded_service()
                if current is None:
                    return False
                if current["desiredCount"] == 2:
                    return True
                cleanup_error("capacity-read", RuntimeError("Capacity differs from baseline"), attempt)
            except Exception as error:
                cleanup_error("capacity-read", error, attempt)
            if attempt < RESTORE_ATTEMPTS:
                time.sleep(RESTORE_DELAY)
        return False

    def collect_scale_out_activity():
        # Task counts can settle before Application Auto Scaling marks an activity complete.
        for attempt in range(1, ACTIVITY_ATTEMPTS + 1):
            report["activityReadAttempts"] = attempt
            try:
                activities = scaling.describe_scaling_activities(**KEY, MaxResults=20)["ScalingActivities"]
                relevant = [
                    activity for activity in activities
                    if activity["StartTime"] >= started_at and activity.get("StatusCode") == "Successful"
                    and activity.get("Description") == "Setting desired count to 4."
                    and any(name in activity.get("Cause", "") for name in scale_out_alarm_names)
                ]
                report["scalingActivities"] = [
                    {key: activity.get(key) for key in ("StartTime", "EndTime", "StatusCode", "Description", "Cause")}
                    for activity in relevant
                ]
                if relevant:
                    return True
            except Exception as error:
                cleanup_error("scaling-activities", error, attempt)
            if attempt < ACTIVITY_ATTEMPTS:
                time.sleep(ACTIVITY_DELAY)
        return False

    try:
        # Recheck immediately before the reversible policy change.
        validate_preflight(service(), target, policy)
        temporary = {**original, "TargetValue": 1, "DisableScaleIn": True}
        changed = True
        applied = scaling.put_scaling_policy(**KEY, PolicyName=POLICY, PolicyType="TargetTrackingScaling",
                                            TargetTrackingScalingPolicyConfiguration=temporary)
        scale_out_alarm_names = {
            alarm["AlarmName"] for alarm in applied.get("Alarms", [])
            if isinstance(alarm.get("AlarmName"), str) and alarm["AlarmName"]
        } or original_alarm_names
        report["reachedMaxCapacity"] = observe(4, 300, "automatic-scale-out")
        save()
    except Exception as error:
        report["error"] = type(error).__name__
        raise
    finally:
        cleaning_up = True
        try:
            if changed:
                try:
                    report["policyRestored"] = restore_policy()
                except Exception as error:
                    cleanup_error("policy-restore", error)
                finally:
                    try:
                        if report["policyRestored"] and not report.get("interrupted"):
                            report["automaticScaleIn"] = observe(2, 180, "automatic-scale-in")
                            report["baselineRestored"] = report["automaticScaleIn"]
                    except Exception as error:
                        cleanup_error("automatic-scale-in", error)
                    finally:
                        # Observation or policy errors must never skip the guarded fallback.
                        if not report["baselineRestored"]:
                            try:
                                if restore_capacity():
                                    report["baselineRestored"] = observe(2, 180, "baseline-cleanup")
                            except Exception as error:
                                cleanup_error("baseline-cleanup", error)
        finally:
            try:
                if report["reachedMaxCapacity"]:
                    report["automaticScaleOut"] = collect_scale_out_activity()
            except Exception as error:
                cleanup_error("scaling-activities", error)
            finally:
                report["finishedAt"] = datetime.now(timezone.utc).isoformat()
                report["passed"] = (report["automaticScaleOut"] and report["policyRestored"]
                                    and report["baselineRestored"] and report["httpErrors"] == 0
                                    and not report.get("error") and not report.get("interrupted"))
                try:
                    save()
                finally:
                    for signum, handler in previous_handlers.items():
                        signal.signal(signum, handler)
    print(json.dumps({key: report[key] for key in ("passed", "automaticScaleOut", "automaticScaleIn", "policyRestored", "baselineRestored", "httpErrors")}))
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
