"""Optional integrations reuse .env without asking for or printing keys again."""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "workshop/scripts"))
import lab


class ProviderEnvTests(unittest.TestCase):
    def test_explicit_env_file_feeds_only_the_selected_provider_parameter(self):
        from workshop_env import write_env
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            write_env(path, {"KAKAO_REST_API_KEY": "test-only-kakao", "TOURAPI_SERVICE_KEY": "other-provider"})
            requests = []
            class Client:
                def put_parameter(self, **kwargs):
                    requests.append(kwargs)
                    return {"Version": 2}
            session = SimpleNamespace(client=lambda service: Client())
            output = io.StringIO()
            with patch.object(lab, "resource_names", return_value={"project": "jeju-atlas-lab-team01"}), \
                    patch.object(lab, "aws_session", return_value=session), \
                    patch.object(lab.getpass, "getpass", side_effect=AssertionError("Do not prompt again")), \
                    redirect_stdout(output):
                lab.set_provider_secret({"participant": "team01"}, SimpleNamespace(
                    provider="kakao", execute=True, env_file=path,
                ))
            self.assertEqual(requests[0]["Name"], "/jeju-atlas-lab-team01/kakao-rest-api-key")
            self.assertEqual(requests[0]["Value"], "test-only-kakao")
            self.assertNotIn("test-only-kakao", output.getvalue())
            self.assertNotIn("other-provider", json.dumps(requests))

    def test_missing_key_stops_before_aws_and_plan_does_not_read_an_env_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text("KAKAO_REST_API_KEY=\n")
            with patch.object(lab, "resource_names", return_value={"project": "jeju-atlas-lab-team01"}), \
                    patch.object(lab, "aws_session", side_effect=AssertionError("No AWS request")), \
                    redirect_stdout(io.StringIO()):
                with self.assertRaises(ValueError):
                    lab.set_provider_secret({"participant": "team01"}, SimpleNamespace(
                        provider="kakao", execute=True, env_file=path,
                    ))
                path.unlink()
                lab.set_provider_secret({"participant": "team01"}, SimpleNamespace(
                    provider="kakao", execute=False, env_file=path,
                ))


if __name__ == "__main__":
    unittest.main()
