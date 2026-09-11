"""Read-only deployment verification against ECS-shaped fixtures; no AWS calls."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from origin_tls_test import load_verifier

REPO = "061525506239.dkr.ecr.ap-northeast-2.amazonaws.com/jeju-3d"
WEB = REPO + "@sha256:" + "a" * 64
ROUTER = REPO + "@sha256:" + "b" * 64
UPDATED = "2026-09-10T20:21:06Z"
TASK = "arn:aws:ecs:ap-northeast-2:061525506239:task-definition/jeju-3d:20"


class RoutingVerificationTest(unittest.TestCase):
    def setUp(self):
        self.verify = load_verifier()
        self.settings = self.verify.validate_settings({
            "RoutingEnabled": "true", "TaskCpu": 512, "TaskMemory": 1024, "RoutingMemory": 512,
        })
        self.parameters = {
            "TaskCpu": "512", "TaskMemory": "1024", "RoutingMemory": "512",
            "RoutingImageUri": ROUTER, "RoutingDataUpdatedAt": UPDATED,
        }
        self.image = {"imageUri": WEB, "release": "test", "routing": {"imageUri": ROUTER, "dataUpdatedAt": UPDATED}}
        self.web = {
            "name": "web", "image": WEB, "user": "1000:1000", "readonlyRootFilesystem": True,
            "environment": [{"name": "ROUTING_URL", "value": "http://127.0.0.1:8002"},
                            {"name": "ROUTING_DATA_UPDATED_AT", "value": UPDATED}],
            "mountPoints": [{"sourceVolume": "catalog-cache", "containerPath": "/tmp", "readOnly": False}],
            "dependsOn": [{"containerName": "routing", "condition": "START"}],
        }
        self.router = {
            "name": "routing", "image": ROUTER, "user": "65532:65532", "readonlyRootFilesystem": True,
            "essential": False, "cpu": 256, "memory": 512, "memoryReservation": 256,
            "linuxParameters": {"capabilities": {"drop": ["ALL"]}},
            "restartPolicy": {"enabled": True, "restartAttemptPeriod": 60},
            "mountPoints": [{"sourceVolume": "routing-cache", "containerPath": "/tmp", "readOnly": False}],
            "healthCheck": {"command": ["CMD", "python3", "/opt/routing/healthcheck.py"],
                            "interval": 30, "timeout": 5, "retries": 3, "startPeriod": 15},
            "stopTimeout": 120, "portMappings": [], "secrets": [],
        }
        self.taskdef = {
            "taskDefinitionArn": TASK, "cpu": "512", "memory": "1024", "networkMode": "awsvpc",
            "runtimePlatform": {"cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX"},
            "requiresCompatibilities": ["FARGATE"],
            "taskRoleArn": "arn:aws:iam::061525506239:role/Jeju3dApp-TaskRole-test",
            "volumes": [{"name": "catalog-cache", "host": {}}, {"name": "routing-cache", "host": {}}],
            "containerDefinitions": [self.web, self.router],
        }
        self.outputs = {
            "ClusterName": "jeju-3d", "ServiceName": "jeju-3d",
            "TaskSecurityGroupId": "sg-task", "TargetGroupArn": "arn:owned:target-group",
        }
        self.service = {
            "taskDefinition": TASK, "desiredCount": 2, "runningCount": 2, "pendingCount": 0,
            "deployments": [{"rolloutState": "COMPLETED"}],
            "networkConfiguration": {"awsvpcConfiguration": {
                "subnets": self.verify.PRIVATE, "assignPublicIp": "DISABLED", "securityGroups": ["sg-task"],
            }},
            "loadBalancers": [{"targetGroupArn": self.outputs["TargetGroupArn"], "containerName": "web", "containerPort": 8080}],
        }
        self.tasks = [
            {"taskDefinitionArn": TASK, "healthStatus": "HEALTHY", "lastStatus": "RUNNING",
             "containers": [{"name": "web", "lastStatus": "RUNNING", "healthStatus": "HEALTHY"},
                            {"name": "routing", "image": ROUTER, "lastStatus": "RUNNING", "healthStatus": "HEALTHY"}]}
            for _ in range(2)
        ]
        self.enis = [
            {"NetworkInterfaceId": f"eni-{i}", "VpcId": self.verify.VPC, "SubnetId": subnet,
             "Groups": [{"GroupId": "sg-task"}], "PrivateIpAddress": f"10.0.{i}.5"}
            for i, subnet in enumerate(self.verify.PRIVATE)
        ]

    def configuration(self):
        self.assertTrue(callable(getattr(self.verify, "verify_task_configuration", None)))
        checks = {}
        self.configuration_diagnostics = []

        def record(name, passed, detail=None):
            checks[name] = bool(passed)
            self.configuration_diagnostics.append({"check": name, "passed": bool(passed), "detail": detail})

        self.verify.verify_task_configuration(
            self.taskdef, self.parameters, self.settings, self.image, record,
        )
        self.assertTrue(checks)
        return checks

    def placement(self):
        self.assertTrue(callable(getattr(self.verify, "verify_routing_runtime", None)))
        checks = {}
        self.verify.verify_routing_runtime(
            self.tasks, self.service, self.enis, self.outputs, self.image,
            lambda name, passed, detail=None: checks.update({name: bool(passed)}),
        )
        self.assertTrue(checks)
        return checks

    def test_main_accepts_new_capacity_and_rejects_router_exposure_before_iam_reads(self):
        class ReachedIam(Exception):
            pass

        cf = SimpleNamespace(
            describe_stacks=lambda **kwargs: {"Stacks": [{"StackStatus": "UPDATE_COMPLETE", "Parameters": [
                {"ParameterKey": key, "ParameterValue": value} for key, value in self.parameters.items()
            ]}]},
            list_stack_resources=lambda **kwargs: {"StackResourceSummaries": []},
        )
        ecs = SimpleNamespace(
            describe_services=lambda **kwargs: {"services": [self.service]},
            describe_task_definition=lambda **kwargs: {"taskDefinition": self.taskdef},
        )

        def client(name):
            if name == "iam":
                raise ReachedIam()
            return {"cloudformation": cf, "ecs": ecs}.get(name, object())

        network = {"subnets": [{"role": "private-ecs", "defaultRoute": value} for value in
                               ["nat-00b8a70dc184a4d0c", "nat-08379e076e2e6e234"]]}
        for exposed in (False, True):
            with self.subTest(exposed=exposed), tempfile.TemporaryDirectory() as directory:
                self.router["portMappings"] = [{"containerPort": 8002}] if exposed else []
                settings = Path(directory) / "settings.json"
                settings.write_text(json.dumps(self.settings))
                results = []
                with patch.object(self.verify, "connect", return_value=SimpleNamespace(client=client)), \
                        patch.object(self.verify, "stack_outputs", return_value=self.outputs), \
                        patch.object(self.verify, "assert_network"), patch.object(self.verify, "SETTINGS", settings), \
                        patch.object(self.verify, "load", side_effect=lambda name: self.image if name == "image.json" else network), \
                        patch.object(self.verify, "emit", side_effect=results.append):
                    with self.assertRaises(ReachedIam):
                        self.verify.verify()
                self.assertTrue(results)
                self.assertEqual(all(row["passed"] for row in results), not exposed, results)

    def test_valid_configurations_allow_measured_capacity_and_container_reordering(self):
        for cpu, memory, routing_memory in [("512", "1024", 512), ("1024", "2048", 1024)]:
            with self.subTest(cpu=cpu):
                self.settings.update(TaskCpu=cpu, TaskMemory=memory, RoutingMemory=str(routing_memory))
                self.parameters.update(TaskCpu=cpu, TaskMemory=memory, RoutingMemory=str(routing_memory))
                self.taskdef.update(cpu=cpu, memory=memory)
                self.router["memory"] = routing_memory
                self.taskdef["containerDefinitions"] = [{"name": "aws-guardduty-agent"}, self.router, self.web]
                self.assertTrue(all(self.configuration().values()))

    def test_legacy_no_routing_keeps_256_cpu_512_memory_without_new_parameters(self):
        self.settings = self.verify.validate_settings({})
        self.parameters = {}
        self.image.pop("routing")
        self.web["environment"] = []
        self.web.pop("dependsOn")
        self.taskdef.update(cpu="256", memory="512", containerDefinitions=[self.web],
                            volumes=[{"name": "catalog-cache", "host": {}}])
        self.assertTrue(all(self.configuration().values()))
        self.web["environment"] = [{"name": "ROUTING_URL", "value": "http://127.0.0.1:8002"}]
        self.assertFalse(all(self.configuration().values()))

    def test_capacity_drift_and_invalid_fargate_pairs_fail(self):
        cases = [
            ("taskdef", "cpu", "256"), ("taskdef", "memory", "512"),
            ("parameters", "TaskCpu", "1024"), ("parameters", "TaskMemory", "2048"),
            ("settings", "TaskMemory", "512"), ("taskdef", "networkMode", "bridge"),
            ("taskdef", "requiresCompatibilities", ["EC2"]),
            ("taskdef", "runtimePlatform", {"cpuArchitecture": "X86_64", "operatingSystemFamily": "LINUX"}),
        ]
        for target, key, value in cases:
            with self.subTest(target=target, key=key):
                row = getattr(self, target)
                before = deepcopy(row[key])
                row[key] = value
                self.assertFalse(all(self.configuration().values()))
                row[key] = before

    def test_router_image_and_source_must_match_both_parameters_and_the_release_pair(self):
        for row, key, value in [
            (self.parameters, "RoutingImageUri", REPO + "@sha256:" + "c" * 64),
            (self.parameters, "RoutingDataUpdatedAt", "2026-09-01T00:00:00Z"),
            (self.router, "image", REPO + ":mutable"),
            (self.image["routing"], "imageUri", "other.example/routing@sha256:" + "b" * 64),
        ]:
            with self.subTest(key=key, value=value):
                before = row[key]
                row[key] = value
                self.assertFalse(all(self.configuration().values()))
                row[key] = before
        for field, value in [(0, "http://public.example:8002"), (1, "2020-01-01T00:00:00Z")]:
            before = self.web["environment"][field]["value"]
            self.web["environment"][field]["value"] = value
            self.assertFalse(all(self.configuration().values()))
            self.web["environment"][field]["value"] = before

    def test_router_isolation_healthcheck_and_private_tmp_are_required(self):
        mutations = {
            "user": "0:0", "readonlyRootFilesystem": False, "essential": True,
            "portMappings": [{"containerPort": 8002}], "memory": 2048,
            "secrets": [{"name": "LEAK", "valueFrom": "PRIVATE_TEST_VALUE"}],
            "environment": [{"name": "AWS_SECRET_ACCESS_KEY", "value": "PRIVATE_TEST_VALUE"}],
            "environmentFiles": [{"type": "s3", "value": "arn:aws:s3:::external/environment"}],
            "linuxParameters": {"capabilities": {"drop": ["ALL"], "add": ["SYS_ADMIN"]}},
            "mountPoints": [{"sourceVolume": "catalog-cache", "containerPath": "/tmp", "readOnly": False}],
            "healthCheck": {"command": ["CMD-SHELL", "true"], "interval": 30, "timeout": 5, "retries": 3},
            "restartPolicy": {"enabled": False}, "stopTimeout": 30,
        }
        for key, value in mutations.items():
            with self.subTest(key=key):
                before = deepcopy(self.router)
                self.router[key] = value
                results = self.configuration()
                self.assertFalse(all(results.values()))
                self.assertNotIn("PRIVATE_TEST_VALUE", json.dumps(self.configuration_diagnostics))
                self.router.clear()
                self.router.update(before)

    def test_running_router_health_is_checked_even_when_task_aggregate_is_healthy(self):
        self.assertTrue(all(self.placement().values()))
        route = self.tasks[0]["containers"][1]
        for key, value in [("healthStatus", "UNHEALTHY"), ("lastStatus", "STOPPED"), ("image", WEB)]:
            before = route[key]
            route[key] = value
            self.assertFalse(all(self.placement().values()))
            route[key] = before
        self.tasks[0]["containers"].pop()
        self.assertFalse(all(self.placement().values()))

    def test_service_and_enis_cannot_expose_or_relocate_the_native_router(self):
        awsvpc = self.service["networkConfiguration"]["awsvpcConfiguration"]
        for row, key, value in [
            (awsvpc, "assignPublicIp", "ENABLED"), (awsvpc, "subnets", self.verify.PUBLIC),
            (awsvpc, "securityGroups", ["sg-task", "sg-extra"]),
            (self.enis[0], "Groups", [{"GroupId": "sg-extra"}]),
            (self.enis[0], "Association", {"PublicIp": "203.0.113.1"}),
            (self.service["loadBalancers"][0], "containerName", "routing"),
            (self.service["loadBalancers"][0], "containerPort", 8002),
        ]:
            with self.subTest(key=key):
                before = deepcopy(row)
                row[key] = value
                self.assertFalse(all(self.placement().values()))
                row.clear()
                row.update(before)


if __name__ == "__main__":
    unittest.main()
