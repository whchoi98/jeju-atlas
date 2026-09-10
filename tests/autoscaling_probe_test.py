"""Run the native autoscaling probe entirely against in-memory AWS/HTTP fakes."""
import contextlib
import copy
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
from pathlib import Path
import signal
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
ORIGINAL = {
    "TargetValue": 70, "ScaleOutCooldown": 60, "ScaleInCooldown": 300,
    "PredefinedMetricSpecification": {"PredefinedMetricType": "ECSServiceAverageMemoryUtilization"},
}


class AWSFixture:
    def __init__(self, **faults):
        self.faults = faults
        self.policy = copy.deepcopy(ORIGINAL)
        self.desired = 2
        self.clock = 0
        self.mutations = []
        self.restore_puts = 0
        self.restore_reads = 0
        self.capacity_puts = 0
        self.cleanup_service_reads = 0
        self.health_reads = 0
        self.activity_reads = 0
        self.activity_read_states = []
        self.activity_started = None
        self.temporary_applied = False
        self.handlers = {}
        self.client_configs = []
        self.outputs = {
            "ClusterName": "jeju-3d", "ServiceName": "jeju-3d",
            "TargetGroupArn": "owned-test-target", "ApplicationUrl": "https://probe.invalid",
        }

    def client(self, name, **kwargs):
        if name not in {"ecs", "application-autoscaling", "elbv2", "cloudformation"}:
            raise AssertionError(f"Unexpected AWS service: {name}")
        self.client_configs.append(kwargs.get("config"))
        return self

    def describe_stacks(self, **kwargs):
        assert kwargs == {"StackName": "Jeju3dApp"}
        return {"Stacks": [{"StackStatus": "UPDATE_COMPLETE"}]}

    def describe_services(self, **kwargs):
        assert kwargs == {"cluster": "jeju-3d", "services": ["jeju-3d"]}
        if self.restore_puts:
            self.cleanup_service_reads += 1
            if self.cleanup_service_reads <= self.faults.get("service_read_failures", 0):
                raise RuntimeError("SIMULATED_PRIVATE_ERROR")
        concurrent = self.restore_puts and self.faults.get("concurrent_deployment")
        return {"services": [{
            "serviceName": "jeju-3d", "desiredCount": self.desired,
            "runningCount": self.desired, "pendingCount": 0,
            "taskDefinition": "owned-test-task:2" if concurrent == "task_definition" else "owned-test-task:1",
            "deployments": [{"id": "ecs-svc/original", "rolloutState": "COMPLETED"}]
                + ([{"id": "ecs-svc/replacement", "rolloutState": "IN_PROGRESS"}] if concurrent == "same_task_definition" else []),
        }]}

    def describe_scalable_targets(self, **kwargs):
        assert kwargs == {
            "ServiceNamespace": "ecs", "ResourceIds": ["service/jeju-3d/jeju-3d"],
            "ScalableDimension": "ecs:service:DesiredCount",
        }
        return {"ScalableTargets": [{"MinCapacity": 2, "MaxCapacity": 4}]}

    def describe_scaling_policies(self, **kwargs):
        self.assert_owned(kwargs)
        if self.restore_puts:
            self.restore_reads += 1
            if self.restore_reads <= self.faults.get("policy_read_failures", 0):
                raise RuntimeError("SIMULATED_PRIVATE_ERROR")
        return {"ScalingPolicies": [{
            "PolicyName": "jeju-3d-memory", "PolicyType": "TargetTrackingScaling",
            "TargetTrackingScalingPolicyConfiguration": copy.deepcopy(self.policy),
            "Alarms": [{"AlarmName": "memory-high"}],
        }]}

    @staticmethod
    def assert_owned(kwargs):
        assert kwargs["ServiceNamespace"] == "ecs"
        assert kwargs["ResourceId"] == "service/jeju-3d/jeju-3d"
        assert kwargs["ScalableDimension"] == "ecs:service:DesiredCount"

    def put_scaling_policy(self, **kwargs):
        self.assert_owned(kwargs)
        assert kwargs["PolicyName"] == "jeju-3d-memory" and kwargs["PolicyType"] == "TargetTrackingScaling"
        configuration = kwargs["TargetTrackingScalingPolicyConfiguration"]
        self.mutations.append(("policy", copy.deepcopy(configuration)))
        if configuration["TargetValue"] == 1:
            assert configuration == {**ORIGINAL, "TargetValue": 1, "DisableScaleIn": True}
            self.temporary_applied = True
            self.policy = copy.deepcopy(configuration)
            self.desired = 3 if self.faults.get("never_reach_max") else 4
            self.activity_started = datetime.now(timezone.utc)
            if self.faults.get("interrupt"):
                self.handlers[signal.SIGTERM](signal.SIGTERM, None)
            if "temporary_alarm_names" in self.faults:
                return {"Alarms": [{"AlarmName": name} for name in self.faults["temporary_alarm_names"]]}
            return {}
        assert configuration == ORIGINAL
        self.restore_puts += 1
        if self.restore_puts <= self.faults.get("policy_put_failures", 0):
            raise RuntimeError("SIMULATED_PRIVATE_ERROR")
        self.policy = copy.deepcopy(configuration)
        if self.faults.get("interrupt_cleanup") and self.restore_puts == 1:
            self.handlers[signal.SIGTERM](signal.SIGTERM, None)
        if self.faults.get("policy_commit_then_error"):
            raise RuntimeError("SIMULATED_PRIVATE_ERROR")
        return {}

    def describe_target_health(self, **kwargs):
        assert kwargs == {"TargetGroupArn": "owned-test-target"}
        if self.restore_puts:
            self.health_reads += 1
            if self.health_reads <= self.faults.get("health_read_failures", 0):
                raise RuntimeError("SIMULATED_PRIVATE_ERROR")
        return {"TargetHealthDescriptions": [{"TargetHealth": {"State": "healthy"}} for _ in range(self.desired)]}

    def describe_scaling_activities(self, **kwargs):
        self.assert_owned(kwargs)
        self.activity_reads += 1
        self.activity_read_states.append((self.policy["TargetValue"], self.desired))
        if self.activity_reads <= self.faults.get("activity_read_failures", 0):
            raise RuntimeError("SIMULATED_PRIVATE_ERROR")
        states = self.faults.get("activity_statuses", ["Successful"])
        status = states[min(self.activity_reads - 1, len(states) - 1)]
        if self.faults.get("activity_pending_until_cleanup") and not self.capacity_puts:
            status = "InProgress"
        started = self.activity_started
        if self.faults.get("old_activity"):
            started -= timedelta(minutes=10)
        return {"ScalingActivities": [{
            "StartTime": started, "EndTime": datetime.now(timezone.utc) if status == "Successful" else None,
            "StatusCode": status, "Cause": self.faults.get("activity_alarm", "memory-high"),
            "Description": self.faults.get("activity_description", "Setting desired count to 4."),
        }]}

    def update_service(self, **kwargs):
        assert kwargs == {"cluster": "jeju-3d", "service": "jeju-3d", "desiredCount": 2}
        self.capacity_puts += 1
        self.mutations.append(("capacity", 2))
        if self.capacity_puts <= self.faults.get("capacity_put_failures", 0):
            raise RuntimeError("SIMULATED_PRIVATE_ERROR")
        self.desired = 2
        return {}

    def sleep(self, seconds):
        assert 0 <= seconds <= 10
        self.clock += seconds

    def signal(self, signum, handler):
        previous = self.handlers.get(signum, signal.SIG_DFL)
        self.handlers[signum] = handler
        return previous


class AutoscalingProbeTest(unittest.TestCase):
    def run_probe(self, fixture, execute=True):
        module = ModuleType("deploy")
        module.APP = "Jeju3dApp"
        module.connect = lambda: fixture
        module.stack_outputs = lambda *args: fixture.outputs
        spec = importlib.util.spec_from_file_location("autoscaling_probe", ROOT / "scripts/verify-autoscaling.py")
        probe = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"deploy": module}):
            spec.loader.exec_module(probe)
        with tempfile.TemporaryDirectory(prefix="jeju-autoscaling-test-") as directory:
            output = Path(directory) / "report.json"
            args = ["probe", "--output", str(output)] + (["--execute"] if execute else [])
            error = None
            with patch.object(sys, "argv", args), \
                    patch.object(probe.signal, "signal", fixture.signal), \
                    patch.object(probe.time, "monotonic", lambda: fixture.clock), \
                    patch.object(probe.time, "sleep", fixture.sleep), \
                    patch.object(probe.requests, "get", return_value=SimpleNamespace(
                        status_code=200, json=lambda: {"service": "jeju-3d"})), \
                    contextlib.redirect_stdout(io.StringIO()):
                try:
                    probe.main()
                except (Exception, SystemExit) as caught:
                    error = caught
            report = json.loads(output.read_text())
        self.assertNotIn("SIMULATED_PRIVATE_ERROR", json.dumps(report))
        return report, error

    def assert_restored(self, fixture, report):
        self.assertEqual(fixture.policy, ORIGINAL)
        self.assertEqual(fixture.desired, 2)
        self.assertTrue(report["policyRestored"])
        self.assertTrue(report["baselineRestored"])
        self.assertIn("finishedAt", report)

    def test_preview_cannot_mutate_aws(self):
        fixture = AWSFixture()
        report, error = self.run_probe(fixture, execute=False)
        self.assertIsNone(error)
        self.assertEqual(report["mode"], "preview")
        self.assertEqual(fixture.mutations, [])

    def test_transient_policy_write_or_read_failure_restores_original_and_capacity(self):
        for faults in [{"policy_put_failures": 1}, {"policy_read_failures": 1},
                       {"policy_commit_then_error": True}]:
            with self.subTest(faults=faults):
                fixture = AWSFixture(**faults)
                report, error = self.run_probe(fixture)
                self.assertIsNone(error)
                self.assert_restored(fixture, report)
                self.assertLessEqual(fixture.restore_puts, 3)
                self.assertLessEqual(fixture.restore_reads, 3)

    def test_observation_failure_still_runs_guarded_capacity_restore(self):
        fixture = AWSFixture(health_read_failures=1)
        report, error = self.run_probe(fixture)
        self.assertIsNone(error)
        self.assertEqual(fixture.capacity_puts, 1)
        self.assertFalse(report["automaticScaleIn"])
        self.assertTrue(report["manualCapacityRestore"])
        self.assert_restored(fixture, report)

    def test_capacity_write_and_read_failures_have_bounded_recovery(self):
        for faults in [{"capacity_put_failures": 1}, {"service_read_failures": 2}]:
            with self.subTest(faults=faults):
                fixture = AWSFixture(**faults)
                report, error = self.run_probe(fixture)
                self.assertIsNone(error)
                self.assert_restored(fixture, report)
                self.assertLessEqual(fixture.capacity_puts, 3)

    def test_exhausted_policy_restore_still_attempts_capacity_and_finalizes_failure(self):
        fixture = AWSFixture(policy_put_failures=99)
        report, error = self.run_probe(fixture)
        self.assertIsNotNone(error)
        self.assertEqual(fixture.restore_puts, 3)
        self.assertEqual(fixture.restore_reads, 3)
        self.assertEqual(fixture.capacity_puts, 1)
        self.assertEqual(fixture.desired, 2)
        self.assertFalse(report["policyRestored"])
        self.assertFalse(report["passed"])
        self.assertIn("finishedAt", report)

    def test_exhausted_capacity_restore_finalizes_failure_without_unbounded_retries(self):
        fixture = AWSFixture(capacity_put_failures=99)
        report, error = self.run_probe(fixture)
        self.assertIsNotNone(error)
        self.assertEqual(fixture.policy, ORIGINAL)
        self.assertEqual(fixture.capacity_puts, 3)
        self.assertFalse(report["baselineRestored"])
        self.assertFalse(report["passed"])
        self.assertIn("finishedAt", report)

    def test_concurrent_deployments_are_not_scaled_in_by_cleanup(self):
        for change in ["task_definition", "same_task_definition"]:
            with self.subTest(change=change):
                fixture = AWSFixture(concurrent_deployment=change)
                report, error = self.run_probe(fixture)
                self.assertIsNotNone(error)
                self.assertEqual(fixture.policy, ORIGINAL)
                self.assertEqual(fixture.capacity_puts, 0)
                self.assertFalse(report["baselineRestored"])
                self.assertIn("finishedAt", report)

    def test_interruptions_trigger_cleanup_and_do_not_interrupt_restoration_again(self):
        fixture = AWSFixture(interrupt=True, interrupt_cleanup=True)
        report, error = self.run_probe(fixture)
        self.assertIsInstance(error, InterruptedError)
        self.assert_restored(fixture, report)
        self.assertFalse(report["passed"])
        self.assertTrue(all(handler == signal.SIG_DFL for handler in fixture.handlers.values()))

    def test_probe_aws_clients_have_finite_timeouts_without_hidden_write_retries(self):
        fixture = AWSFixture()
        _, error = self.run_probe(fixture, execute=False)
        self.assertIsNone(error)
        self.assertEqual(len(fixture.client_configs), 4)
        for config in fixture.client_configs:
            self.assertIsNotNone(config)
            self.assertLessEqual(config.connect_timeout, 5)
            self.assertLessEqual(config.read_timeout, 10)
            self.assertEqual(config.retries["total_max_attempts"], 1)

    def test_successful_activity_is_collected_after_cleanup_even_if_pending_at_capacity_four(self):
        fixture = AWSFixture(activity_pending_until_cleanup=True)
        report, error = self.run_probe(fixture)
        self.assertIsNone(error)
        self.assertTrue(report.get("reachedMaxCapacity"))
        self.assertTrue(report["automaticScaleOut"])
        self.assertTrue(report["passed"])
        self.assertEqual(report["scalingActivities"][0]["StatusCode"], "Successful")
        self.assertEqual(fixture.activity_read_states, [(70, 2)])
        self.assert_restored(fixture, report)

    def test_final_activity_reads_retry_pending_or_transient_failures_without_repeating_mutations(self):
        for faults in [{"activity_statuses": ["InProgress", "Successful"]}, {"activity_read_failures": 1}]:
            with self.subTest(faults=faults):
                fixture = AWSFixture(**faults)
                report, error = self.run_probe(fixture)
                self.assertIsNone(error)
                self.assertTrue(report["passed"])
                self.assertEqual(fixture.activity_read_states, [(70, 2), (70, 2)])
                self.assertEqual(fixture.mutations, [
                    ("policy", {**ORIGINAL, "TargetValue": 1, "DisableScaleIn": True}),
                    ("policy", ORIGINAL), ("capacity", 2),
                ])
                self.assert_restored(fixture, report)

    def test_temporary_policy_alarm_names_take_precedence_with_original_fallback(self):
        cases = [
            ({"temporary_alarm_names": ["temporary-high", "temporary-low"], "activity_alarm": "temporary-high"}, True),
            ({"temporary_alarm_names": ["temporary-high"], "activity_alarm": "memory-high"}, False),
            ({"temporary_alarm_names": []}, True),
            ({}, True),
        ]
        for faults, expected in cases:
            with self.subTest(faults=faults):
                fixture = AWSFixture(**faults)
                report, error = self.run_probe(fixture)
                self.assertEqual(report["automaticScaleOut"], expected)
                self.assertEqual(report["passed"], expected)
                self.assertEqual(error is None, expected)
                self.assert_restored(fixture, report)

    def test_missing_or_wrong_scale_out_evidence_fails_with_capacity_restored(self):
        for faults in [
            {"activity_statuses": ["InProgress"]}, {"activity_statuses": ["Failed"]},
            {"activity_read_failures": 99}, {"old_activity": True},
            {"activity_description": "Setting desired count to 3."},
            {"temporary_alarm_names": ["temporary-high", "temporary-low"],
             "activity_alarm": "temporary-low", "activity_description": "Setting desired count to 2."},
        ]:
            with self.subTest(faults=faults):
                fixture = AWSFixture(**faults)
                report, error = self.run_probe(fixture)
                self.assertIsInstance(error, SystemExit)
                self.assertTrue(report.get("reachedMaxCapacity"))
                self.assertFalse(report["automaticScaleOut"])
                self.assertFalse(report["passed"])
                self.assertEqual(fixture.activity_reads, 3)
                self.assert_restored(fixture, report)

    def test_successful_activity_alone_cannot_replace_observed_max_capacity(self):
        fixture = AWSFixture(never_reach_max=True)
        report, error = self.run_probe(fixture)
        self.assertIsInstance(error, SystemExit)
        self.assertIs(report.get("reachedMaxCapacity"), False)
        self.assertFalse(report["automaticScaleOut"])
        self.assertEqual(fixture.activity_reads, 0)
        self.assert_restored(fixture, report)


if __name__ == "__main__":
    unittest.main()
