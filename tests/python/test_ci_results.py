"""A skipped or unfinished dependency must not turn a required CI gate green."""

import contextlib
import copy
import io
import json
import os
import unittest
from unittest.mock import patch

from tools.ci import check_results


def results(mode="full"):
    return {
        "changes": {"result": "success", "outputs": {"mode": mode}},
        "source": {"result": "success", "outputs": {}},
        "browser": {"result": "success", "outputs": {}},
        "compose": {"result": "success", "outputs": {}},
    }


class RequiredResultsTests(unittest.TestCase):
    def test_every_full_job_must_succeed(self):
        self.assertEqual(check_results.failures(results()), [])
        for job in check_results.JOBS:
            for result in ("failure", "cancelled", "skipped", "unknown", None):
                with self.subTest(job=job, result=result):
                    value = results()
                    value[job]["result"] = result
                    self.assertTrue(check_results.failures(value))

    def test_only_exact_successful_docs_classification_permits_browser_compose_skips(
        self,
    ):
        value = results("docs")
        value["browser"]["result"] = "skipped"
        value["compose"]["result"] = "skipped"
        self.assertEqual(check_results.failures(value), [])
        self.assertEqual(check_results.failures(results("docs")), [])
        for job in ("changes", "source"):
            for result in ("failure", "cancelled", "skipped", None):
                with self.subTest(job=job, result=result):
                    broken = copy.deepcopy(value)
                    broken[job]["result"] = result
                    self.assertTrue(check_results.failures(broken))
        for job in ("browser", "compose"):
            for result in ("failure", "cancelled", "unknown", None):
                with self.subTest(job=job, result=result):
                    broken = copy.deepcopy(value)
                    broken[job]["result"] = result
                    self.assertTrue(check_results.failures(broken))

    def test_unknown_missing_and_nonstring_modes_fail_even_if_jobs_claim_success(self):
        for mode in ("", "unknown", None, ["docs"], {"mode": "docs"}):
            with self.subTest(mode=mode):
                self.assertTrue(check_results.failures(results(mode)))
        value = results()
        value["changes"]["outputs"] = {}
        self.assertTrue(check_results.failures(value))

    def test_missing_extra_or_malformed_job_records_fail(self):
        for job in check_results.JOBS:
            value = results()
            del value[job]
            self.assertTrue(check_results.failures(value))
            value = results()
            value[job] = None
            self.assertTrue(check_results.failures(value))
        value = results()
        value["unreviewed"] = {"result": "failure"}
        self.assertTrue(check_results.failures(value))
        for value in (None, [], "success", {}):
            self.assertTrue(check_results.failures(value))

    def test_cli_accepts_success_and_propagates_dependency_failure(self):
        for result in ("success", "cancelled", "failure", "skipped"):
            value = results()
            value["browser"]["result"] = result
            with (
                self.subTest(result=result),
                patch.dict(os.environ, {"NEEDS_JSON": json.dumps(value)}, clear=True),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                if result == "success":
                    check_results.main()
                else:
                    with self.assertRaises(SystemExit) as error:
                        check_results.main()
                    self.assertEqual(error.exception.code, 1)

    def test_cli_missing_or_malformed_input_fails_without_reflecting_payload(self):
        for environment in (
            {},
            {"NEEDS_JSON": "private-token"},
            {"NEEDS_JSON": '"private-token"'},
        ):
            output = io.StringIO()
            with (
                patch.dict(os.environ, environment, clear=True),
                contextlib.redirect_stdout(output),
                self.assertRaises(SystemExit),
            ):
                check_results.main()
            self.assertNotIn("private-token", output.getvalue())


if __name__ == "__main__":
    unittest.main()
