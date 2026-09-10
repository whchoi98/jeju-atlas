import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("origin_deploy", ROOT / "scripts/deploy.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class CanonicalOriginSettingsTests(unittest.TestCase):
    def settings(self):
        return {
            "ViewerDomainName": "jeju-atlas.whchoi.net",
            "ViewerCertificateArn": f"arn:aws:acm:us-east-1:{deploy.ACCOUNT}:certificate/12345678-1234-1234-1234-123456789abc",
            "OriginDomainName": "",
            "OriginTlsEnabled": "true",
            "OriginTlsMode": "canonical-host",
        }

    def test_canonical_mode_uses_the_existing_viewer_identity_without_inventing_origin_dns(self):
        result = deploy.validate_settings(self.settings())
        self.assertEqual(result["OriginTlsMode"], "canonical-host")
        self.assertEqual(result["OriginDomainName"], "")
        self.assertEqual(result["OriginTlsEnabled"], "true")

    def test_dns_mode_keeps_its_previous_separate_origin_requirement(self):
        values = self.settings()
        values["OriginTlsMode"] = "dns"
        for target in ("", "jeju-atlas.whchoi.net"):
            values["OriginDomainName"] = target
            with self.assertRaises(ValueError):
                deploy.validate_settings(values)
        values["OriginDomainName"] = "jeju-atlas-origin.whchoi.net"
        self.assertEqual(deploy.validate_settings(values)["OriginTlsMode"], "dns")

    def test_unknown_modes_or_missing_viewer_certificates_are_rejected(self):
        values = self.settings()
        values["OriginTlsMode"] = "insecure"
        with self.assertRaises(ValueError):
            deploy.validate_settings(values)
        values = self.settings()
        values["ViewerDomainName"] = values["ViewerCertificateArn"] = ""
        with self.assertRaises(ValueError):
            deploy.validate_settings(values)


if __name__ == "__main__":
    unittest.main()
