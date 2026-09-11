"""Runtime relocation and collector-drain regressions, without AWS access."""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "workshop/scripts"))
import lab
import lab_artifacts
from lab_config import resource_names


class PortabilityAndCleanupTests(unittest.TestCase):
    def test_console_launcher_survives_removing_the_builder_python(self):
        self.assertTrue(hasattr(lab_artifacts, "normalize_console_scripts"),
                        "Normalize builder-specific console script shebangs before packaging")
        with tempfile.TemporaryDirectory(prefix="atlas-launcher-") as directory:
            root = Path(directory)
            builder = root / "builder/bin"
            builder.mkdir(parents=True)
            (builder / "python3").symlink_to(sys.executable)
            package = root / "packages"
            (package / "bin").mkdir(parents=True)
            executable = package / "bin/tool"
            executable.write_text(f"#!{builder}/python3\nprint('portable-runtime')\n")
            executable.chmod(0o755)
            lab_artifacts.normalize_console_scripts(package)
            shutil.rmtree(root / "builder")
            output = subprocess.check_output([str(executable)], text=True)
            self.assertEqual(output.strip(), "portable-runtime")
            self.assertEqual(executable.read_text().splitlines()[0], "#!/usr/bin/env python3")

    def test_schedule_is_disabled_and_only_owned_collector_tasks_are_drained(self):
        self.assertTrue(hasattr(lab, "drain_collectors"),
                        "Disable scheduling and drain collectors before cluster deletion")
        config = {"participant": "team01", "accountId": "123456789012"}
        names = resource_names(config)
        calls = []
        schedule_name = names["project"] + "-official-details"
        task_definition = f"arn:aws:ecs:ap-northeast-2:123456789012:task-definition/{names['project']}-data:2"
        task_arn = f"arn:aws:ecs:ap-northeast-2:123456789012:task/{names['project']}/collector"
        scheduler = Mock()
        scheduler.get_schedule.return_value = {
            "Name": schedule_name, "GroupName": "default", "ScheduleExpression": "rate(7 days)",
            "FlexibleTimeWindow": {"Mode": "OFF"}, "Target": {"Arn": "owned-cluster", "RoleArn": "owned-role"},
            "State": "ENABLED", "CreationDate": "not-an-update-field",
        }
        scheduler.update_schedule.side_effect = lambda **kwargs: calls.append(("disable", kwargs))
        ecs = Mock()
        ecs.list_tasks.return_value = {"taskArns": [task_arn]}
        ecs.describe_tasks.return_value = {
            "tasks": [{"taskArn": task_arn, "taskDefinitionArn": task_definition, "lastStatus": "RUNNING"}],
            "failures": [],
        }
        ecs.stop_task.side_effect = lambda **kwargs: calls.append(("stop", kwargs))
        ecs.get_waiter.return_value.wait.side_effect = lambda **kwargs: calls.append(("wait", kwargs))
        session = Mock()
        session.client.side_effect = lambda service, **kwargs: scheduler if service == "scheduler" else ecs
        stacks = [
            {"name": names["stackPrefix"] + "App", "resources": [
                {"type": "AWS::ECS::Cluster", "physicalId": names["project"], "logicalId": "Cluster"}]},
            {"name": names["stackPrefix"] + "Data", "resources": [
                {"type": "AWS::Scheduler::Schedule", "physicalId": schedule_name, "logicalId": "RefreshSchedule"},
                {"type": "AWS::ECS::TaskDefinition", "physicalId": task_definition, "logicalId": "WorkerTaskDefinition"}]},
        ]
        lab.drain_collectors(config, session, stacks)
        self.assertEqual([call[0] for call in calls], ["disable", "stop", "wait"])
        self.assertEqual(calls[0][1]["State"], "DISABLED")
        self.assertNotIn("CreationDate", calls[0][1])
        self.assertEqual(calls[1][1]["task"], task_arn)
        self.assertEqual(ecs.list_tasks.call_args.kwargs["family"], names["project"] + "-data")

    def test_drain_rejects_a_task_from_another_family_before_stopping_anything(self):
        self.assertTrue(hasattr(lab, "drain_collectors"))
        config = {"participant": "team01", "accountId": "123456789012"}
        names = resource_names(config)
        ecs = Mock()
        ecs.list_tasks.return_value = {"taskArns": ["other-task"]}
        ecs.describe_tasks.return_value = {
            "tasks": [{"taskArn": "other-task", "taskDefinitionArn":
                       "arn:aws:ecs:ap-northeast-2:123456789012:task-definition/production:1",
                       "lastStatus": "RUNNING"}], "failures": []}
        session = Mock()
        session.client.return_value = ecs
        stacks = [{"name": names["stackPrefix"] + "App", "resources": [
            {"type": "AWS::ECS::Cluster", "physicalId": names["project"], "logicalId": "Cluster"}]}]
        with self.assertRaises(ValueError):
            lab.drain_collectors(config, session, stacks)
        ecs.stop_task.assert_not_called()


if __name__ == "__main__":
    unittest.main()
