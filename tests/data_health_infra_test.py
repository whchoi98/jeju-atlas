"""Offline tests for data-health event paths, alarm timing and SNS boundaries."""
import fnmatch
import json
import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
ACCOUNT = "061525506239"
TOPIC = f"arn:aws:sns:ap-northeast-2:{ACCOUNT}:jeju-3d-operations-alarms"
ABSENT = object()


class Loader(yaml.SafeLoader):
    pass


def intrinsic(loader, tag, node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node)
    else:
        value = loader.construct_mapping(node)
    return {tag if tag in ("Ref", "Condition") else "Fn::" + tag: value}


Loader.add_multi_constructor("!", intrinsic)


def load(name):
    return yaml.load((ROOT / "infra" / name).read_text(), Loader=Loader)


def materialize(template, overrides=None, stack="Jeju3dData"):
    values = {name: spec["Default"] for name, spec in template["Parameters"].items() if "Default" in spec}
    values.update({
        "AWS::Partition": "aws", "AWS::Region": "ap-northeast-2",
        "AWS::AccountId": ACCOUNT, "AWS::StackName": stack,
        "AWS::NoValue": ABSENT,
    })
    values.update(overrides or {})

    def evaluate(value):
        if isinstance(value, list):
            return [result for item in value if (result := evaluate(item)) is not ABSENT]
        if not isinstance(value, dict):
            return value
        if "Ref" in value:
            return values.get(value["Ref"], f"resource:{value['Ref']}")
        if set(value) == {"Condition"} and isinstance(value["Condition"], str):
            return evaluate(template["Conditions"][value["Condition"]])
        if "Fn::Equals" in value:
            a, b = evaluate(value["Fn::Equals"])
            return a == b
        if "Fn::Not" in value:
            return not evaluate(value["Fn::Not"][0])
        if "Fn::And" in value:
            return all(evaluate(item) for item in value["Fn::And"])
        if "Fn::Or" in value:
            return any(evaluate(item) for item in value["Fn::Or"])
        if "Fn::If" in value:
            name, yes, no = value["Fn::If"]
            return evaluate(yes if evaluate({"Condition": name}) else no)
        if "Fn::Sub" in value:
            return re.sub(r"\$\{([^}]+)\}", lambda match: str(values.get(match[1], f"resource:{match[1]}")), value["Fn::Sub"])
        return {key: result for key, child in value.items() if (result := evaluate(child)) is not ABSENT}

    return {
        name: evaluate(resource)
        for name, resource in template["Resources"].items()
        if "Condition" not in resource or evaluate({"Condition": resource["Condition"]})
    }


def matches(pattern, event):
    """Evaluate the small documented JSON filter subset used by these templates."""
    tokens = re.findall(r'\$\.[A-Za-z0-9_.]+|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|>=|<=|!=|=|>|<|&&|\|\||[()]', pattern)
    position = 0

    def take():
        nonlocal position
        value = tokens[position]
        position += 1
        return value

    def atom():
        nonlocal position
        if tokens[position] == "(":
            take()
            value = disjunction()
            assert take() == ")"
            return value
        field, operator, literal = take(), take(), take()
        expected = json.loads(literal)
        actual = event
        for part in field[2:].split("."):
            actual = actual.get(part, ABSENT) if isinstance(actual, dict) else ABSENT
        if actual is ABSENT or type(actual) is not type(expected):
            if not (type(actual) in (int, float) and type(expected) in (int, float)):
                return False
        return {
            "=": lambda: actual == expected, "!=": lambda: actual != expected,
            ">": lambda: actual > expected, ">=": lambda: actual >= expected,
            "<": lambda: actual < expected, "<=": lambda: actual <= expected,
        }[operator]()

    def conjunction():
        nonlocal position
        value = atom()
        while position < len(tokens) and tokens[position] == "&&":
            take()
            next_value = atom()
            value = value and next_value
        return value

    def disjunction():
        nonlocal position
        value = conjunction()
        while position < len(tokens) and tokens[position] == "||":
            take()
            next_value = conjunction()
            value = value or next_value
        return value

    result = disjunction()
    assert position == len(tokens)
    return result


def metric(resource, event):
    props = resource["Properties"]
    if not matches(props["FilterPattern"], event):
        return None
    transform, = props["MetricTransformations"]
    value = transform["MetricValue"]
    return event[value[2:]] if value.startswith("$.") else float(value)


def filters(resources):
    return [item for item in resources.values() if item["Type"] == "AWS::Logs::MetricFilter"]


def alarms(resources):
    return [item["Properties"] for item in resources.values() if item["Type"] == "AWS::CloudWatch::Alarm"]


def by_metric(resources, name):
    return next(item for item in filters(resources) if item["Properties"]["MetricTransformations"][0]["MetricName"] == name)


class DataHealthInfrastructureTests(unittest.TestCase):
    def setUp(self):
        self.ops = load("operations.yaml")
        self.data = load("data.yaml")
        self.worker = {"WorkerImageUri": ACCOUNT + ".dkr.ecr.ap-northeast-2.amazonaws.com/jeju-3d@sha256:" + "a" * 64}

    def test_official_details_are_opt_in_and_independent_from_base_catalog(self):
        self.assertIn("OfficialDetailsEnabled", self.ops["Parameters"])
        disabled = materialize(self.ops, stack="Jeju3dOperations")
        self.assertFalse(any("OfficialDetails" in str(item) for item in filters(disabled)))
        enabled = materialize(self.ops, {"OfficialDetailsEnabled": "true"}, stack="Jeju3dOperations")
        details = by_metric(enabled, "OfficialDetailsStale")
        self.assertEqual(metric(details, {"event": "official_details_status", "stale": 0}), 0)
        self.assertEqual(metric(details, {"event": "official_details_status", "stale": 1}), 1)
        for event in [
            {"event": "catalog_status", "stale": 0},
            {"event": "official_details_status", "stale": "0"},
            {"event": "official_details_status", "stale": False},
            {"event": "official_details_status", "generated_at": "2026-09-10"},
        ]:
            self.assertIsNone(metric(details, event))
        transform, = details["Properties"]["MetricTransformations"]
        self.assertNotIn("DefaultValue", transform, "Unrelated app logs cannot conceal an absent details heartbeat")
        alarm = next(item for item in alarms(enabled) if item.get("MetricName") == "OfficialDetailsStale")
        self.assertEqual((alarm["Period"], alarm["EvaluationPeriods"], alarm["DatapointsToAlarm"]), (60, 3, 2))
        self.assertEqual((alarm["Statistic"], alarm["Threshold"], alarm["ComparisonOperator"]), ("Maximum", 1, "GreaterThanOrEqualToThreshold"))
        self.assertEqual(alarm["TreatMissingData"], "breaching")
        self.assertNotEqual(alarm["MetricName"], "CatalogStale")
        self.assertEqual(alarm["AlarmActions"], ["resource:Notifications"])

    def test_worker_filters_require_a_worker_and_extract_only_their_own_numeric_events(self):
        self.assertFalse(filters(materialize(self.data)))
        enabled = materialize(self.data, self.worker)
        provider = by_metric(enabled, "ProviderFailures")
        failed = by_metric(enabled, "CollectionFailures")
        completed = by_metric(enabled, "CollectionCompletions")
        self.assertEqual(metric(provider, {"event": "collection_complete", "provider_failures": 3}), 3)
        self.assertEqual(metric(provider, {"event": "collection_complete", "provider_failures": 0}), 0)
        for event in [{"event": "collection_complete", "failures": [{}]}, {"event": "source_lists", "provider_failures": 3}]:
            self.assertIsNone(metric(provider, event))
        self.assertEqual(metric(failed, {"event": "collection_failed", "code": "job_deadline"}), 1)
        self.assertIsNone(metric(failed, {"event": "collection_complete", "updated": 0}))
        self.assertEqual(metric(completed, {"event": "collection_complete", "updated": 0, "partial": False}), 1)
        self.assertEqual(metric(completed, {"event": "collection_complete", "updated": 50}), 1)
        self.assertIsNone(metric(completed, {"event": "collection_failed"}))
        self.assertNotIn("DefaultValue", completed["Properties"]["MetricTransformations"][0])

    def test_custom_metrics_match_alarm_namespaces_without_high_cardinality_dimensions(self):
        for template, parameters, stack, log_group in [
            (self.ops, {"OfficialDetailsEnabled": "true", "LogGroupName": "/ecs/jeju-3d"}, "Jeju3dOperations", "/ecs/jeju-3d"),
            (self.data, self.worker, "Jeju3dData", "resource:WorkerLogs"),
        ]:
            resources = materialize(template, parameters, stack=stack)
            for item in filters(resources):
                props = item["Properties"]
                transform, = props["MetricTransformations"]
                self.assertEqual(props["LogGroupName"], log_group)
                self.assertNotIn("Dimensions", transform)
                self.assertNotIn("EmitSystemFieldDimensions", props)
                self.assertTrue(transform["MetricNamespace"].endswith("/" + stack))
                direct_alarms = [alarm for alarm in alarms(resources) if alarm.get("MetricName") == transform["MetricName"]]
                for alarm in direct_alarms:
                    self.assertEqual(alarm["Namespace"], transform["MetricNamespace"])
                    self.assertNotIn("Dimensions", alarm)
                self.assertEqual(transform["Unit"], "Count")

    def test_worker_error_alarms_ignore_idle_periods_but_alert_on_each_failure(self):
        self.assertFalse(alarms(materialize(self.data)))
        enabled = materialize(self.data, self.worker)
        for name in ["ProviderFailures", "CollectionFailures"]:
            alarm, = [item for item in alarms(enabled) if item.get("MetricName") == name]
            self.assertEqual(alarm["Statistic"], "Sum")
            self.assertEqual((alarm["Period"], alarm["EvaluationPeriods"], alarm["DatapointsToAlarm"]), (300, 1, 1))
            self.assertEqual((alarm["ComparisonOperator"], alarm["Threshold"]), ("GreaterThanThreshold", 0))
            self.assertEqual(alarm["TreatMissingData"], "notBreaching")

    def test_missing_completion_watches_48_hours_only_while_schedule_is_enabled(self):
        self.assertFalse(any("Metrics" in item for item in alarms(materialize(self.data, self.worker))))
        self.assertFalse(alarms(materialize(self.data, {"ScheduleState": "ENABLED"})))
        resources = materialize(self.data, {**self.worker, "ScheduleState": "ENABLED"})
        alarm, = [item for item in alarms(resources) if "Metrics" in item]
        transform, = by_metric(resources, "CollectionCompletions")["Properties"]["MetricTransformations"]
        queries = {item["Id"]: item for item in alarm["Metrics"]}
        output, = [item for item in queries.values() if item.get("ReturnData")]
        source, = [item for item in queries.values() if "MetricStat" in item]
        self.assertEqual(output["Expression"].replace(" ", ""), f"FILL({source['Id']},0)")
        self.assertFalse(source["ReturnData"])
        metric_stat = source["MetricStat"]
        self.assertEqual(metric_stat["Metric"], {
            "Namespace": transform["MetricNamespace"], "MetricName": "CollectionCompletions",
        })
        self.assertEqual((metric_stat["Period"], metric_stat["Stat"], metric_stat["Unit"]), (3600, "Sum", "Count"))
        self.assertEqual((alarm["EvaluationPeriods"], alarm["DatapointsToAlarm"]), (48, 48))
        self.assertEqual((alarm["ComparisonOperator"], alarm["Threshold"]), ("LessThanThreshold", 1))
        self.assertEqual(alarm["TreatMissingData"], "breaching")
        self.assertNotIn("Period", alarm, "A math alarm takes the period from its metric query")
        # Exercise the intended metric values at window boundaries, including a
        # successful collection that deliberately preserves all existing records.
        def breaches(hours):
            window = hours[-alarm["EvaluationPeriods"]:]
            return sum((value or 0) < alarm["Threshold"] for value in window) >= alarm["DatapointsToAlarm"]
        success = metric(by_metric(resources, "CollectionCompletions"), {"event": "collection_complete", "updated": 0})
        self.assertTrue(breaches([None] * 48))
        self.assertFalse(breaches([success] + [None] * 47))
        self.assertTrue(breaches([success] + [None] * 48))
        self.assertFalse(breaches([None] * 47 + [success]))

    def test_notifications_are_optional_and_only_accept_the_owned_operations_topic(self):
        parameter = self.data["Parameters"]["DataNotificationsTopicArn"]
        self.assertEqual(parameter["Default"], "")
        self.assertEqual(set(parameter["AllowedValues"]), {"", TOPIC})
        for value in [
            TOPIC.replace(ACCOUNT, "111111111111"),
            TOPIC.replace("ap-northeast-2", "us-east-1"),
            TOPIC + "-other",
            "arn:aws:sns:ap-northeast-2:061525506239:*",
        ]:
            self.assertNotIn(value, parameter["AllowedValues"])
        params = {**self.worker, "ScheduleState": "ENABLED"}
        for alarm in alarms(materialize(self.data, params)):
            self.assertNotIn("AlarmActions", alarm)
            self.assertNotIn("OKActions", alarm)
        with_topic = alarms(materialize(self.data, {**params, "DataNotificationsTopicArn": TOPIC}))
        self.assertEqual(len(with_topic), 3)
        for alarm in with_topic:
            self.assertEqual(alarm["AlarmActions"], [TOPIC])
            self.assertEqual(alarm["OKActions"], [TOPIC])
            self.assertNotIn("InsufficientDataActions", alarm)

    def test_sns_owner_policy_authorizes_only_its_own_and_the_three_data_alarms(self):
        ops = materialize(self.ops, {"OfficialDetailsEnabled": "true"}, stack="Jeju3dOperations")
        data = materialize(self.data, {**self.worker, "ScheduleState": "ENABLED", "DataNotificationsTopicArn": TOPIC})
        policies = [item for item in ops.values() if item["Type"] == "AWS::SNS::TopicPolicy"]
        self.assertEqual(len(policies), 1, "The owner alone must manage the shared topic policy")
        policy = policies[0]["Properties"]
        self.assertEqual(policy["Topics"], ["resource:Notifications"])
        statement, = policy["PolicyDocument"]["Statement"]
        self.assertEqual(statement["Principal"], {"Service": "cloudwatch.amazonaws.com"})
        self.assertEqual(statement["Action"], "sns:Publish")
        self.assertEqual(statement["Resource"], "resource:Notifications")
        self.assertEqual(statement["Condition"]["StringEquals"], {"aws:SourceAccount": ACCOUNT})
        patterns = statement["Condition"]["ArnLike"]["aws:SourceArn"]
        self.assertIsInstance(patterns, list)
        prefix = f"arn:aws:cloudwatch:ap-northeast-2:{ACCOUNT}:alarm:"
        def permitted(arn):
            return any(fnmatch.fnmatchcase(arn, pattern) for pattern in patterns)
        for alarm in alarms(ops) + alarms(data):
            self.assertTrue(permitted(prefix + alarm["AlarmName"]), alarm["AlarmName"])
        for arn in [
            prefix + "Jeju3dData-other",
            prefix + "OtherStack-collection-failed",
            prefix.replace(ACCOUNT, "111111111111") + "Jeju3dData-collection-failed",
            prefix.replace("ap-northeast-2", "us-east-1") + "Jeju3dData-collection-failed",
        ]:
            self.assertFalse(permitted(arn), arn)
        self.assertEqual(len(patterns), 4)
        for resources in [ops, data]:
            self.assertFalse(any(item["Type"] == "AWS::SNS::Subscription" for item in resources.values()))
            for item in resources.values():
                if item["Type"] == "AWS::SNS::Topic":
                    self.assertNotIn("Subscription", item["Properties"])
        self.assertFalse(any(item["Type"] in ("AWS::SNS::Topic", "AWS::SNS::TopicPolicy") for item in data.values()))

    def test_alarms_require_no_new_worker_permissions_or_data_deletion(self):
        for resource in self.data["Resources"].values():
            if resource["Type"] == "AWS::IAM::Role":
                policies = json.dumps(resource["Properties"].get("Policies", []))
                for disallowed in ["sns:", "cloudwatch:", "logs:PutMetricFilter", "s3:Delete"]:
                    self.assertNotIn(disallowed, policies)
        bucket = self.data["Resources"]["DetailsBucket"]
        self.assertEqual(bucket["DeletionPolicy"], "Retain")
        self.assertEqual(bucket["UpdateReplacePolicy"], "Retain")
        self.assertEqual(bucket["Properties"]["VersioningConfiguration"]["Status"], "Enabled")
