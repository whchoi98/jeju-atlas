"""Offline contracts for the two standalone operations stacks.

These guard deployment boundaries, privacy, and alarm semantics. They neither
call AWS nor require access to live application outputs.
"""
import json
import posixpath
import re
import unittest
from pathlib import Path
from urllib.parse import unquote

import yaml

ROOT = Path(__file__).resolve().parents[1]


class CloudFormationLoader(yaml.SafeLoader):
    pass


def intrinsic(loader, tag, node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node)
    else:
        value = loader.construct_mapping(node)
    key = tag if tag == "Ref" else "Fn::" + tag
    if tag == "GetAtt" and isinstance(value, str):
        value = value.split(".", 1)
    return {key: value}


CloudFormationLoader.add_multi_constructor("!", intrinsic)


def resources_of(template, resource_type):
    return {
        name: resource for name, resource in template["Resources"].items()
        if resource["Type"] == resource_type
    }


def descendants(value):
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from descendants(item)
    elif isinstance(value, list):
        for item in value:
            yield from descendants(item)


def path_matches(statement, path):
    """Evaluate the URI-path subset used by the WAF rate scope."""
    if "OrStatement" in statement:
        return any(path_matches(child, path) for child in statement["OrStatement"]["Statements"])
    if "AndStatement" in statement:
        return all(path_matches(child, path) for child in statement["AndStatement"]["Statements"])
    rule = statement["ByteMatchStatement"]
    if rule["FieldToMatch"] != {"UriPath": {}}:
        raise AssertionError("Rate scope must inspect only the URI path")
    for transform in sorted(rule["TextTransformations"], key=lambda item: item["Priority"]):
        if transform["Type"] == "URL_DECODE":
            path = unquote(path)
        elif transform["Type"] == "NORMALIZE_PATH":
            trailing = path.endswith("/")
            path = posixpath.normpath(path)
            if trailing and path != "/":
                path += "/"
        elif transform["Type"] != "NONE":
            raise AssertionError("Unexpected path transformation")
    if rule["PositionalConstraint"] == "STARTS_WITH":
        return path.startswith(rule["SearchString"])
    if rule["PositionalConstraint"] == "EXACTLY":
        return path == rule["SearchString"]
    raise AssertionError("Unexpected scope match operator")


def resolve(value, parameters):
    if isinstance(value, list):
        return [resolve(item, parameters) for item in value]
    if not isinstance(value, dict):
        return value
    if "Ref" in value:
        return parameters[value["Ref"]]
    if "Fn::Split" in value:
        separator, text = resolve(value["Fn::Split"], parameters)
        return text.split(separator)
    if "Fn::Select" in value:
        index, items = resolve(value["Fn::Select"], parameters)
        return items[int(index)]
    if "Fn::Sub" in value:
        expression = value["Fn::Sub"]
        if isinstance(expression, list):
            text, variables = expression
            context = {**parameters, **resolve(variables, parameters)}
        else:
            text, context = expression, parameters
        return re.sub(r"\$\{([^}]+)\}", lambda match: str(context[match.group(1)]), text)
    return {key: resolve(item, parameters) for key, item in value.items()}


class OperationsInfrastructureTests(unittest.TestCase):
    def load(self, name):
        path = ROOT / "infra" / name
        self.assertTrue(path.is_file(), f"Missing required standalone template: {name}")
        return yaml.load(path.read_text(), Loader=CloudFormationLoader)

    def test_stacks_do_not_own_application_compute_network_or_distribution(self):
        allowed = {
            "AWS::WAFv2::WebACL", "AWS::Logs::LogGroup",
            "AWS::Logs::DeliverySource", "AWS::Logs::DeliveryDestination",
            "AWS::Logs::Delivery", "AWS::Logs::MetricFilter",
            "AWS::CloudWatch::Alarm", "AWS::CloudWatch::Dashboard",
            "AWS::SNS::Topic", "AWS::SNS::TopicPolicy",
        }
        for name in ["edge.yaml", "operations.yaml"]:
            with self.subTest(template=name):
                template = self.load(name)
                self.assertTrue(template["Resources"])
                self.assertLessEqual({item["Type"] for item in template["Resources"].values()}, allowed)
                self.assertNotIn("Transform", template)
                for node in descendants(template):
                    self.assertNotIn("Fn::ImportValue", node, "Regions must use explicit output parameters")

    def test_waf_limits_api_ips_without_throttling_terrain_or_static_files(self):
        template = self.load("edge.yaml")
        acl, = resources_of(template, "AWS::WAFv2::WebACL").values()
        properties = acl["Properties"]
        self.assertEqual(properties["Scope"], "CLOUDFRONT")
        self.assertEqual(properties["DefaultAction"], {"Allow": {}})
        rate, = [rule for rule in properties["Rules"] if "RateBasedStatement" in rule["Statement"]]
        statement = rate["Statement"]["RateBasedStatement"]
        self.assertEqual(statement["AggregateKeyType"], "IP")
        self.assertEqual(statement["EvaluationWindowSec"], 300)
        self.assertEqual(rate["Action"], {"Block": {}})
        scope = statement["ScopeDownStatement"]
        for path in ["/api/config", "/api/guide", "/api/catalog/points", "/api/weather", "/%61pi/guide"]:
            self.assertTrue(path_matches(scope, path), path)
        for path in ["/", "/index.html", "/assets/app.js", "/healthz", "/apiary", "/terrarium/14/13950/6579.png"]:
            self.assertFalse(path_matches(scope, path), path)

    def test_waf_does_not_sample_requests_or_block_valid_8_to_16kb_bodies(self):
        template = self.load("edge.yaml")
        acl, = resources_of(template, "AWS::WAFv2::WebACL").values()
        visibility = [node["VisibilityConfig"] for node in descendants(acl) if "VisibilityConfig" in node]
        self.assertGreaterEqual(len(visibility), 3)
        self.assertTrue(all(item["SampledRequestsEnabled"] is False for item in visibility))
        self.assertTrue(all(item["CloudWatchMetricsEnabled"] is True for item in visibility))
        managed, = [node["ManagedRuleGroupStatement"] for node in descendants(acl) if "ManagedRuleGroupStatement" in node]
        self.assertEqual(managed["VendorName"], "AWS")
        self.assertEqual(managed["Name"], "AWSManagedRulesCommonRuleSet")
        size, = [item for item in managed["RuleActionOverrides"] if item["Name"] == "SizeRestrictions_BODY"]
        self.assertEqual(size["ActionToUse"], {"Count": {}})
        self.assertFalse(resources_of(template, "AWS::WAFv2::LoggingConfiguration"))

    def test_global_waf_and_cloudfront_use_their_distinct_metric_dimensions(self):
        template = self.load("edge.yaml")
        dashboard, = resources_of(template, "AWS::CloudWatch::Dashboard").values()
        body = json.loads(resolve(dashboard["Properties"]["DashboardBody"], {
            "AWS::Region": "us-east-1", "AWS::StackName": "Jeju3dEdge",
            "DistributionArn": "arn:aws:cloudfront::061525506239:distribution/EDISTRIBUTION",
        }))
        waf_metrics = []
        for widget in body["widgets"]:
            for metric in widget["properties"].get("metrics", []):
                dimensions = dict(zip(metric[2::2], metric[3::2]))
                if metric[0] == "AWS/WAFV2":
                    waf_metrics.append(metric)
                    self.assertEqual(dimensions, {"WebACL": "jeju-3d-edge", "Rule": "ALL"})
                elif metric[0] == "AWS/CloudFront":
                    self.assertEqual(dimensions, {"DistributionId": "EDISTRIBUTION", "Region": "Global"})
        self.assertTrue(waf_metrics)

    def test_standard_logging_v2_has_an_explicit_nonidentifying_field_allowlist(self):
        template = self.load("edge.yaml")
        source, = resources_of(template, "AWS::Logs::DeliverySource").values()
        destination, = resources_of(template, "AWS::Logs::DeliveryDestination").values()
        delivery, = resources_of(template, "AWS::Logs::Delivery").values()
        self.assertEqual(source["Properties"]["ResourceArn"], {"Ref": "DistributionArn"})
        self.assertEqual(source["Properties"]["LogType"], "ACCESS_LOGS")
        self.assertEqual(destination["Properties"]["OutputFormat"], "json")
        fields = delivery["Properties"]["RecordFields"]
        safe = {
            "date", "time", "sc-status", "sc-bytes", "time-taken",
            "time-to-first-byte", "x-edge-location", "x-edge-result-type",
            "x-edge-response-result-type", "x-edge-detailed-result-type",
            "cache-behavior-path-pattern",
        }
        self.assertTrue(fields, "Omitting fields restores unsafe service defaults")
        self.assertLessEqual(set(fields), safe)
        self.assertTrue({"date", "time", "sc-status"}.issubset(fields))
        self.assertEqual(len(set(fields)), len(fields))

    def test_edge_logs_have_bounded_retention_and_a_scoped_delivery_policy(self):
        template = self.load("edge.yaml")
        retention = template["Parameters"]["LogRetentionDays"]
        self.assertEqual(set(retention["AllowedValues"]), {14, 30})
        self.assertIn(retention["Default"], retention["AllowedValues"])
        group, = resources_of(template, "AWS::Logs::LogGroup").values()
        self.assertEqual(group["DeletionPolicy"], "Retain")
        self.assertEqual(group["UpdateReplacePolicy"], "Retain")
        self.assertEqual(group["Properties"]["RetentionInDays"], {"Ref": "LogRetentionDays"})
        policy = group["Properties"]["ResourcePolicyDocument"]
        statements = policy["Statement"]
        for statement in statements:
            self.assertEqual(statement["Principal"], {"Service": "delivery.logs.amazonaws.com"})
            self.assertLessEqual(set(statement["Action"]), {"logs:CreateLogStream", "logs:PutLogEvents"})
            self.assertNotEqual(statement["Resource"], "*")
            self.assertEqual(statement["Condition"]["StringEquals"]["aws:SourceAccount"], {"Ref": "AWS::AccountId"})
            self.assertIn("aws:SourceArn", statement["Condition"]["ArnLike"])
        serialized = json.dumps(policy)
        self.assertIn(":log-group:", serialized)
        self.assertIn(":log-stream:", serialized)

    def test_alarm_topics_have_no_subscribers_and_only_scoped_cloudwatch_publish(self):
        for name in ["edge.yaml", "operations.yaml"]:
            with self.subTest(template=name):
                template = self.load(name)
                self.assertFalse(resources_of(template, "AWS::SNS::Subscription"))
                topics = resources_of(template, "AWS::SNS::Topic")
                self.assertEqual(len(topics), 1)
                topic_id, = topics
                self.assertNotIn("Subscription", topics[topic_id]["Properties"])
                policy, = resources_of(template, "AWS::SNS::TopicPolicy").values()
                self.assertEqual(policy["Properties"]["Topics"], [{"Ref": topic_id}])
                for statement in policy["Properties"]["PolicyDocument"]["Statement"]:
                    self.assertEqual(statement["Principal"], {"Service": "cloudwatch.amazonaws.com"})
                    self.assertEqual(statement["Action"], "sns:Publish")
                    self.assertEqual(statement["Resource"], {"Ref": topic_id})
                    conditions = statement["Condition"]
                    self.assertEqual(conditions["StringEquals"]["aws:SourceAccount"], {"Ref": "AWS::AccountId"})
                    self.assertIn("${AWS::StackName}-", json.dumps(conditions["ArnLike"]["aws:SourceArn"]))
                for alarm in resources_of(template, "AWS::CloudWatch::Alarm").values():
                    self.assertEqual(alarm["Properties"]["AlarmActions"], [{"Ref": topic_id}])
                    self.assertEqual(alarm["Properties"]["OKActions"], [{"Ref": topic_id}])

    def test_health_alarm_requires_two_targets_and_missing_data_breaches(self):
        template = self.load("operations.yaml")
        minimum = template["Parameters"]["MinimumHealthyTargets"]
        self.assertEqual(minimum["Default"], 2)
        self.assertGreaterEqual(minimum["MinValue"], 2)
        alarm, = [
            item["Properties"] for item in resources_of(template, "AWS::CloudWatch::Alarm").values()
            if item["Properties"].get("MetricName") == "HealthyHostCount"
        ]
        self.assertEqual(alarm["Statistic"], "Minimum")
        self.assertEqual(alarm["ComparisonOperator"], "LessThanThreshold")
        self.assertEqual(alarm["Threshold"], {"Ref": "MinimumHealthyTargets"})
        self.assertEqual(alarm["TreatMissingData"], "breaching")
        self.assertEqual(
            {item["Name"]: item["Value"] for item in alarm["Dimensions"]},
            {"LoadBalancer": {"Ref": "AlbFullName"}, "TargetGroup": {"Ref": "TargetGroupFullName"}},
        )

    def test_native_metrics_use_correct_service_dimensions_and_header_latency(self):
        template = self.load("operations.yaml")
        alarms = {item["Properties"].get("MetricName"): item["Properties"]
                  for item in resources_of(template, "AWS::CloudWatch::Alarm").values()}
        for metric in ["HTTPCode_ELB_5XX_Count", "HTTPCode_Target_5XX_Count"]:
            self.assertEqual(alarms[metric]["Statistic"], "Sum")
            self.assertEqual(alarms[metric]["Namespace"], "AWS/ApplicationELB")
        for metric in ["CPUUtilization", "MemoryUtilization"]:
            self.assertEqual(alarms[metric]["Namespace"], "AWS/ECS")
            self.assertEqual(
                {item["Name"]: item["Value"] for item in alarms[metric]["Dimensions"]},
                {"ClusterName": {"Ref": "ClusterName"}, "ServiceName": {"Ref": "ServiceName"}},
            )
        latency = alarms["TargetResponseTime"]
        self.assertEqual(latency["ExtendedStatistic"], "p95")
        self.assertNotIn("Statistic", latency)
        self.assertIn("headers", latency["AlarmDescription"].lower())
        self.assertEqual(latency["EvaluateLowSampleCountPercentile"], "ignore")
        self.assertEqual(alarms["WriteThrottleEvents"]["Namespace"], "AWS/DynamoDB")
        self.assertEqual(alarms["WriteThrottleEvents"]["Dimensions"], [
            {"Name": "TableName", "Value": {"Ref": "GuideQuotaTableName"}},
        ])

    def test_log_metrics_use_safe_events_and_cannot_hide_missing_catalog_heartbeats(self):
        template = self.load("operations.yaml")
        filters = resources_of(template, "AWS::Logs::MetricFilter")
        baseline_filters = {name: item for name, item in filters.items() if "Condition" not in item}
        self.assertEqual(len(baseline_filters), 2)
        self.assertEqual(filters["OfficialDetailsStateMetric"]["Condition"], "MonitorOfficialDetails")
        by_metric = {}
        for item in filters.values():
            properties = item["Properties"]
            self.assertEqual(properties["LogGroupName"], {"Ref": "LogGroupName"})
            transformation, = properties["MetricTransformations"]
            self.assertNotIn("Dimensions", transformation)
            by_metric[transformation["MetricName"]] = (properties["FilterPattern"], transformation)
        guide_pattern, guide = by_metric["GuideFailures"]
        self.assertIn('$.event = "guide_stream_error"', guide_pattern)
        self.assertIn('$.event = "guide_rejected"', guide_pattern)
        self.assertIn("$.status >= 500", guide_pattern)
        self.assertNotIn("guide_cancelled", guide_pattern)
        self.assertEqual(guide["MetricValue"], "1")
        catalog_pattern, catalog = by_metric["CatalogStale"]
        self.assertIn('$.event = "catalog_status"', catalog_pattern)
        self.assertEqual(catalog["MetricValue"], "$.stale")
        self.assertNotIn("DefaultValue", catalog)
        alarm, = [item["Properties"] for item in resources_of(template, "AWS::CloudWatch::Alarm").values()
                  if item["Properties"].get("MetricName") == "CatalogStale"]
        self.assertEqual(alarm["Statistic"], "Maximum")
        self.assertEqual(alarm["TreatMissingData"], "breaching")

    def test_regional_interfaces_and_dashboard_json_are_resolvable_without_secrets(self):
        values = {
            "AWS::Partition": "aws", "AWS::AccountId": "061525506239",
            "DistributionArn": "arn:aws:cloudfront::061525506239:distribution/EDISTRIBUTION",
            "ClusterName": "jeju-3d", "ServiceName": "jeju-3d",
            "AlbFullName": "app/jeju-3d-alb/0123456789abcdef",
            "TargetGroupFullName": "targetgroup/jeju-3d-tasks/0123456789abcdef",
            "LogGroupName": "/ecs/jeju-3d", "GuideQuotaTableName": "jeju-3d-guide-quota",
        }
        required = {
            "edge.yaml": {"DistributionArn"},
            "operations.yaml": {"ClusterName", "ServiceName", "AlbFullName", "TargetGroupFullName", "LogGroupName", "GuideQuotaTableName"},
        }
        for name, region, stack in [("edge.yaml", "us-east-1", "Jeju3dEdge"),
                                    ("operations.yaml", "ap-northeast-2", "Jeju3dOperations")]:
            with self.subTest(template=name):
                template = self.load(name)
                self.assertTrue(required[name].issubset(template["Parameters"]))
                context = {key: item["Default"] for key, item in template["Parameters"].items() if "Default" in item}
                context.update(values, **{"AWS::Region": region, "AWS::StackName": stack})
                dashboard, = resources_of(template, "AWS::CloudWatch::Dashboard").values()
                body = json.loads(resolve(dashboard["Properties"]["DashboardBody"], context))
                self.assertTrue(body["widgets"])
                for widget in body["widgets"]:
                    if widget["type"] == "metric":
                        self.assertEqual(widget["properties"]["region"], region)
                self.assertNotIn("resolve:secretsmanager", json.dumps(template))
                if name == "edge.yaml":
                    self.assertEqual(template["Outputs"]["WebAclArn"]["Value"], {
                        "Fn::GetAtt": ["WebAcl", "Arn"],
                    }, "WebACL Ref is a name|id|scope tuple, not the association ARN")
                    self.assertIn("EDISTRIBUTION", json.dumps(body))


if __name__ == "__main__":
    unittest.main()
