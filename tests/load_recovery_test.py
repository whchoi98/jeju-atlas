"""Bounded verification-script contracts. All HTTP/AWS boundaries are fixtures."""
import copy
import importlib.util
import json
import threading
import unittest
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import requests

ROOT = Path(__file__).resolve().parents[1]
ACCOUNT = "061525506239"
REGION = "ap-northeast-2"
ECS = f"arn:aws:ecs:{REGION}:{ACCOUNT}:"
ELB = f"arn:aws:elasticloadbalancing:{REGION}:{ACCOUNT}:"
CLUSTER = ECS + "cluster/jeju-3d"
SERVICE = ECS + "service/jeju-3d/jeju-3d"
TASKDEF = ECS + "task-definition/jeju-3d:12"
TASK_A = ECS + "task/jeju-3d/" + "a" * 32
TASK_B = ECS + "task/jeju-3d/" + "b" * 32
ALB = ELB + "loadbalancer/app/jeju-3d-alb/1234567890abcdef"
TG = ELB + "targetgroup/jeju-3d-tasks/1234567890abcdef"
PUBLIC_URL = "https://jeju.example.test"
CF_URL = "https://dexample.cloudfront.net"
RELEASE = "release-test-12"
PROOF = "private-test-proof".ljust(43, "A")


def load_script(test, name):
    path = ROOT / "scripts" / name
    test.assertTrue(path.is_file(), f"Missing required script: {name}")
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def config():
    return {
        "version": RELEASE,
        "features": {"catalog": True, "guide": True, "planner": True, "pwa": True},
        "guide": {"daily_limit": 30, "csrf_token": PROOF},
    }


class Response:
    def __init__(self, data, status=200, content_type="application/json"):
        self.status_code = status
        self.headers = {"Content-Type": content_type}
        self.body = json.dumps(data).encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def iter_content(self, chunk_size):
        yield self.body


class SessionFactory:
    def __init__(self, bad_config=False, timeout=False):
        self.calls = []
        self.sessions = 0
        self.lock = threading.Lock()
        self.bad_config = bad_config
        self.timeout = timeout

    def __call__(self):
        owner = self
        with self.lock:
            self.sessions += 1

        class Session:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def get(self, url, **kwargs):
                with owner.lock:
                    owner.calls.append((url, kwargs))
                if owner.timeout:
                    raise requests.Timeout("Do not echo " + PROOF)
                path = urlsplit(url).path
                if path == "/healthz":
                    return Response({"status": "ok", "service": "jeju-3d", "release": RELEASE})
                if path == "/api/config":
                    return Response({"ok": True} if owner.bad_config else config())
                if path == "/api/catalog/search":
                    return Response({
                        "items": [{"id": "poi_0001", "name": "공개 장소", "category": "관광지",
                                   "lat": 33.4, "lng": 126.5}],
                        "total": 1, "has_more": False,
                    })
                raise AssertionError("Unexpected route, including any model route")

        return Session()


def task(arn, az, address):
    return {
        "taskArn": arn, "clusterArn": CLUSTER, "group": "service:jeju-3d",
        "taskDefinitionArn": TASKDEF, "lastStatus": "RUNNING", "desiredStatus": "RUNNING",
        "healthStatus": "HEALTHY", "availabilityZone": az,
        "tags": [{"key": "Project", "value": "jeju-3d"}],
        "attachments": [{
            "type": "ElasticNetworkInterface", "status": "ATTACHED",
            "details": [{"name": "privateIPv4Address", "value": address}],
        }],
    }


class AWSFixture:
    def __init__(self):
        self.account = ACCOUNT
        self.region = REGION
        self.stop_calls = []
        self.stop_error = None
        self.on_stop = None
        self.stack_status = "UPDATE_COMPLETE"
        self.outputs = {
            "ApplicationUrl": PUBLIC_URL, "CloudFrontUrl": CF_URL,
            "ClusterName": "jeju-3d", "ServiceName": "jeju-3d",
            "LoadBalancerArn": ALB, "TargetGroupArn": TG, "TaskDefinitionArn": TASKDEF,
        }
        self.tasks = [task(TASK_A, REGION + "a", "10.100.1.10"),
                      task(TASK_B, REGION + "c", "10.100.2.10")]
        self.targets = [
            {"Target": {"Id": address, "Port": 8080}, "TargetHealth": {"State": "healthy"}}
            for address in ["10.100.1.10", "10.100.2.10"]
        ]
        self.service = {
            "serviceArn": SERVICE, "serviceName": "jeju-3d", "clusterArn": CLUSTER,
            "status": "ACTIVE", "desiredCount": 2, "runningCount": 2, "pendingCount": 0,
            "taskDefinition": TASKDEF, "launchType": "FARGATE",
            "deploymentController": {"type": "ECS"},
            "deployments": [{"status": "PRIMARY", "rolloutState": "COMPLETED",
                             "desiredCount": 2, "runningCount": 2, "pendingCount": 0}],
            "loadBalancers": [{"targetGroupArn": TG, "containerName": "web", "containerPort": 8080}],
            "tags": [{"key": "Project", "value": "jeju-3d"}],
        }

    def clients(self):
        owner = self

        class Client:
            @property
            def meta(self):
                return SimpleNamespace(region_name=owner.region)

            def get_caller_identity(self):
                return {"Account": owner.account}

            def describe_stacks(self, **kwargs):
                assert kwargs == {"StackName": "Jeju3dApp"}
                return {"Stacks": [{
                    "StackId": f"arn:aws:cloudformation:{REGION}:{ACCOUNT}:stack/Jeju3dApp/test",
                    "StackStatus": owner.stack_status,
                    "Outputs": [{"OutputKey": key, "OutputValue": value} for key, value in owner.outputs.items()],
                }]}

            def describe_stack_resource(self, **kwargs):
                assert kwargs["StackName"] == "Jeju3dApp"
                physical = {"Service": SERVICE, "LoadBalancer": ALB, "TargetGroup": TG}
                return {"StackResourceDetail": {"PhysicalResourceId": physical[kwargs["LogicalResourceId"]]}}

            def describe_services(self, **kwargs):
                assert kwargs["cluster"] == "jeju-3d" and kwargs["services"] == ["jeju-3d"]
                return {"services": [copy.deepcopy(owner.service)], "failures": []}

            def list_tasks(self, **kwargs):
                assert kwargs["cluster"] == "jeju-3d"
                assert kwargs["serviceName"] == "jeju-3d"
                assert kwargs["desiredStatus"] == "RUNNING"
                return {"taskArns": [item["taskArn"] for item in owner.tasks]}

            def describe_tasks(self, **kwargs):
                assert kwargs["cluster"] == "jeju-3d"
                selected = [item for item in owner.tasks if item["taskArn"] in kwargs["tasks"]]
                return {"tasks": copy.deepcopy(selected), "failures": []}

            def describe_target_groups(self, **kwargs):
                assert kwargs["TargetGroupArns"] == [TG]
                return {"TargetGroups": [{"TargetGroupArn": TG, "TargetType": "ip",
                                          "Port": 8080, "LoadBalancerArns": [ALB]}]}

            def describe_target_health(self, **kwargs):
                assert kwargs["TargetGroupArn"] == TG
                return {"TargetHealthDescriptions": copy.deepcopy(owner.targets)}

            def stop_task(self, **kwargs):
                owner.stop_calls.append(kwargs)
                if owner.stop_error:
                    raise owner.stop_error
                if owner.on_stop:
                    owner.on_stop(kwargs["task"])
                return {"task": {"taskArn": kwargs["task"], "desiredStatus": "STOPPED"}}

        return {name: Client() for name in ["sts", "cf", "ecs", "elb"]}


class LoadRecoveryTests(unittest.TestCase):
    def test_default_load_executes_exactly_500_gets_excluding_warmup(self):
        module = load_script(self, "load-check.py")
        factory = SessionFactory()
        report = module.run_load(PUBLIC_URL, session_factory=factory)
        self.assertEqual(report["measured"]["requests"], 500)
        self.assertEqual(report["measured"]["errors"], 0)
        self.assertEqual(report["warmup"]["requests"], 6)
        self.assertEqual(len(factory.calls), 507)  # One health check, six warmups, 500 measured.
        paths = Counter(urlsplit(url).path for url, _ in factory.calls)
        self.assertEqual(paths["/api/catalog/search"], 255)
        self.assertEqual(paths["/api/config"], 251)
        self.assertEqual(report["release"], RELEASE)
        self.assertNotIn(PROOF, json.dumps(report))
        searches = {parse_qs(urlsplit(url).query)["q"][0] for url, _ in factory.calls
                    if urlsplit(url).path == "/api/catalog/search"}
        self.assertEqual(searches, {"한라산", "협재", "성산", "가족", "카페"})
        for _, kwargs in factory.calls:
            self.assertFalse(kwargs["allow_redirects"])
            self.assertLessEqual(kwargs["timeout"], 15)
            self.assertNotIn("data", kwargs)
            self.assertNotIn("json", kwargs)

    def test_placeholder_200_config_is_an_error_and_token_text_is_not_reported(self):
        module = load_script(self, "load-check.py")
        report = module.run_load(PUBLIC_URL, sessions=2, warmup=False, session_factory=SessionFactory(bad_config=True))
        self.assertEqual(report["measured"]["requests"], 20)
        self.assertEqual(report["measured"]["errors"], 10)
        self.assertFalse(report["passed"])
        self.assertNotIn(PROOF, json.dumps(report))

    def test_bounds_refuse_load_before_any_request_and_percentiles_are_correct(self):
        module = load_script(self, "load-check.py")
        factory = SessionFactory()
        for sessions in [0, 101]:
            with self.assertRaises(ValueError):
                module.run_load(PUBLIC_URL, sessions=sessions, session_factory=factory)
        self.assertEqual(factory.calls, [])
        report = module.summarize([
            {"route": "a", "elapsed_ms": value, "status": 200, "error": None}
            for value in [10, 20, 30, 40, 100]
        ], 2)
        self.assertEqual((report["p50_ms"], report["p95_ms"], report["max_ms"]), (30, 100, 100))
        self.assertEqual(report["rps"], 2.5)

    def test_both_deployed_domains_pass_and_unrelated_urls_or_saved_outputs_fail(self):
        module = load_script(self, "recovery-check.py")
        fixture = AWSFixture()
        for url in [PUBLIC_URL, CF_URL]:
            self.assertEqual(module.preflight(fixture.clients(), url)["outputs"]["ServiceName"], "jeju-3d")
        for url, saved in [("https://foreign.example.test", None),
                           (PUBLIC_URL, {**fixture.outputs, "ServiceName": "other-service"})]:
            with self.assertRaises(module.Refused):
                module.preflight(fixture.clients(), url, saved_outputs=saved)
        self.assertEqual(fixture.stop_calls, [])

    def test_wrong_account_region_one_target_and_deployments_never_stop(self):
        module = load_script(self, "recovery-check.py")
        cases = ["account", "region", "target", "pending", "deployment", "az", "ownership", "duplicate_ip"]
        for case in cases:
            with self.subTest(case=case):
                fixture = AWSFixture()
                if case == "account":
                    fixture.account = "999999999999"
                elif case == "region":
                    fixture.region = "us-east-1"
                elif case == "target":
                    fixture.targets.pop()
                elif case == "pending":
                    fixture.service["pendingCount"] = 1
                elif case == "deployment":
                    fixture.service["deployments"][0]["rolloutState"] = "IN_PROGRESS"
                elif case == "az":
                    fixture.tasks[1]["availabilityZone"] = REGION + "a"
                elif case == "duplicate_ip":
                    fixture.tasks[1]["attachments"][0]["details"][0]["value"] = "10.100.1.10"
                else:
                    fixture.tasks[1]["group"] = "service:unrelated"
                with self.assertRaises(module.Refused):
                    module.preflight(fixture.clients(), PUBLIC_URL)
                self.assertEqual(fixture.stop_calls, [])

    def test_replacement_rechecks_safety_and_stops_exactly_one_owned_task(self):
        module = load_script(self, "recovery-check.py")
        fixture = AWSFixture()
        clients = fixture.clients()
        target = module.preflight(clients, PUBLIC_URL)
        result = module.request_replacement(clients, target)
        self.assertEqual(result["outcome"], "accepted")
        self.assertEqual(len(fixture.stop_calls), 1)
        self.assertEqual(fixture.stop_calls[0]["cluster"], "jeju-3d")
        self.assertIn(fixture.stop_calls[0]["task"], [TASK_A, TASK_B])

        fixture = AWSFixture()
        clients = fixture.clients()
        target = module.preflight(clients, PUBLIC_URL)
        fixture.targets.pop()  # State changed after the earlier preflight.
        with self.assertRaises(module.Refused):
            module.request_replacement(clients, target)
        self.assertEqual(fixture.stop_calls, [])

        fixture = AWSFixture()
        clients = fixture.clients()
        target = module.preflight(clients, PUBLIC_URL)
        fixture.stack_status = "UPDATE_IN_PROGRESS"
        with self.assertRaises(module.Refused):
            module.request_replacement(clients, target)
        self.assertEqual(fixture.stop_calls, [])

    def test_uncertain_stop_result_is_never_retried_or_retargeted(self):
        module = load_script(self, "recovery-check.py")
        fixture = AWSFixture()
        fixture.stop_error = TimeoutError("private exception " + PROOF)
        clients = fixture.clients()
        target = module.preflight(clients, PUBLIC_URL)
        result = module.request_replacement(clients, target)
        self.assertEqual(result["outcome"], "unknown")
        self.assertEqual(len(fixture.stop_calls), 1)
        self.assertNotIn(PROOF, json.dumps(result))
        with self.assertRaises(module.Refused):
            module.request_replacement(clients, target)
        self.assertEqual(len(fixture.stop_calls), 1)

    def test_readonly_observation_probes_degraded_service_without_stopping_any_task(self):
        module = load_script(self, "recovery-check.py")
        fixture = AWSFixture()
        fixture.targets.pop()
        factory = SessionFactory()
        report = module.run_recovery(PUBLIC_URL, clients=fixture.clients(), duration=1,
                                     session_factory=factory)
        self.assertEqual(fixture.stop_calls, [])
        self.assertGreaterEqual(report["http"]["requests"], 4)
        self.assertFalse(report["service_recovered"])
        self.assertFalse(report["passed"])
        self.assertNotIn(PROOF, json.dumps(report))

    def test_normal_observation_and_replacement_reports_verify_end_state(self):
        module = load_script(self, "recovery-check.py")
        for replace_one in [False, True]:
            with self.subTest(replace_one=replace_one):
                fixture = AWSFixture()
                factory = SessionFactory()
                replacement_arn = ECS + "task/jeju-3d/" + "c" * 32

                def replace(arn):
                    self.assertEqual(arn, TASK_A)
                    self.assertGreaterEqual(len(factory.calls), 4, "Observe HTTP before injecting the fault")
                    fixture.tasks[0] = task(replacement_arn, REGION + "a", "10.100.1.11")
                    fixture.targets[0]["Target"]["Id"] = "10.100.1.11"

                fixture.on_stop = replace
                report = module.run_recovery(
                    PUBLIC_URL, clients=fixture.clients(), duration=1,
                    replace_one=replace_one, session_factory=factory)
                self.assertTrue(report["passed"], report.get("error"))
                self.assertTrue(report["service_recovered"])
                self.assertGreaterEqual(report["http"]["requests"], 4)
                self.assertEqual(len(fixture.stop_calls), 1 if replace_one else 0)
                if replace_one:
                    self.assertTrue(report["replacement_observed"])
                    self.assertIn(replacement_arn, report["final"]["running_task_arns"])
                    self.assertNotIn(TASK_A, report["final"]["running_task_arns"])

    def test_interrupt_during_stop_preserves_uncertain_attempt_in_report(self):
        module = load_script(self, "recovery-check.py")
        fixture = AWSFixture()
        fixture.stop_error = KeyboardInterrupt()
        report = module.run_recovery(PUBLIC_URL, clients=fixture.clients(), duration=1,
                                     replace_one=True, session_factory=SessionFactory())
        self.assertEqual(len(fixture.stop_calls), 1)
        self.assertTrue(report["stop"]["attempted"])
        self.assertEqual(report["stop"]["outcome"], "unknown")
        self.assertFalse(report["passed"])

    def test_failed_http_observer_cannot_report_success_from_preflight_alone(self):
        module = load_script(self, "recovery-check.py")
        factory = SessionFactory()
        starts = 0

        def fail_observer():
            nonlocal starts
            starts += 1
            if starts == 2:
                raise RuntimeError("private data " + PROOF)
            return factory()

        report = module.run_recovery(PUBLIC_URL, clients=AWSFixture().clients(), duration=1,
                                     session_factory=fail_observer)
        self.assertFalse(report["passed"])
        self.assertGreater(report["http"]["errors"], 0)
        self.assertNotIn(PROOF, json.dumps(report))

    def test_sdk_configuration_disables_even_implicit_stop_retries(self):
        module = load_script(self, "recovery-check.py")
        options = []

        class Session:
            def client(self, name, config):
                options.append((name, config))
                return object()

        with patch("boto3.Session", return_value=Session()):
            module.aws_clients()
        self.assertEqual({name for name, _ in options}, {"sts", "cloudformation", "ecs", "elbv2"})
        for _, config in options:
            self.assertEqual(config.region_name, REGION)
            self.assertEqual(config.retries["total_max_attempts"], 1)
            self.assertLessEqual(config.read_timeout, 5)


if __name__ == "__main__":
    unittest.main()
