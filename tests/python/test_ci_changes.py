"""Real Git histories must never hide application changes behind prose commits."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tools.ci import check_changes


class ChangeClassificationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="code-along-ci-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.run_git("init", "--quiet", "--initial-branch=main")
        self.run_git("config", "user.name", "CI fixture")
        self.run_git("config", "user.email", "fixture@example.invalid")
        self.write("README.md", "# Fixture\n")
        self.write("docs/guide.md", "# Guide\n")
        self.write("app.py", "value = 1\n")
        self.base = self.commit()

    def run_git(self, *arguments):
        return check_changes.git(self.root, *arguments).decode().strip()

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def commit(self):
        self.run_git("add", "--all")
        self.run_git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Fixture")
        return self.run_git("rev-parse", "HEAD")

    def push_mode(self, **event_overrides):
        head = self.run_git("rev-parse", "HEAD")
        event = {"before": self.base, "after": head, **event_overrides}
        return check_changes.classify("push", event, head, self.root).mode

    def test_markdown_push_and_markdown_rename_are_docs(self):
        self.write("README.md", "# Updated\n")
        self.run_git("mv", "docs/guide.md", "docs/new-guide.md")
        self.commit()
        self.assertEqual(self.push_mode(), "docs")

    def test_multiple_commits_include_source_before_the_last_prose_commit(self):
        self.write("app.py", "value = 2\n")
        self.commit()
        self.write("README.md", "# Updated\n")
        self.commit()
        self.assertEqual(self.push_mode(), "full")

    def test_source_change_reverted_within_push_leaves_only_prose(self):
        self.write("app.py", "value = 2\n")
        self.commit()
        self.write("app.py", "value = 1\n")
        self.write("README.md", "# Updated\n")
        self.commit()
        self.assertEqual(self.push_mode(), "docs")

    def test_unknown_and_protected_paths_always_require_full(self):
        paths = [
            "apps/web/src/main.tsx",
            ".github/workflows/ci.yml",
            "tools/ci/check_changes.py",
            "pnpm-lock.yaml",
            "uv.lock",
            "package.json",
            "pnpm-workspace.yaml",
            "infra/compose.yaml",
            "packages/runtime-profiles/manifests/core.json",
            "docs/api/openapi.json",
            "docs/architecture/approved-architecture.html",
            "docs/architecture/runner-threat-model.md",
            "docs/architecture/decisions.md",
            "docs/protocols/product-execution.md",
            "docs/security/review.md",
            "docs/AGENTS.md",
            "docs/SECURITY.md",
            "AGENTS.md",
            "DESIGN.md",
            "packages/contracts/README.md",
            "docs/unsafe\nname.md",
            "docs/glob[1].md",
        ]
        for path in paths:
            with self.subTest(path=path):
                self.write(path, "Changed\n")
                self.commit()
                self.assertEqual(self.push_mode(), "full")
                self.run_git("reset", "--hard", self.base)

    def test_regular_document_deletion_is_docs(self):
        (self.root / "docs/guide.md").unlink()
        self.commit()
        self.assertEqual(self.push_mode(), "docs")

    def test_source_deletion_is_full(self):
        (self.root / "app.py").unlink()
        self.commit()
        self.assertEqual(self.push_mode(), "full")

    def test_renaming_source_to_documentation_is_full(self):
        self.run_git("mv", "app.py", "docs/example.md")
        self.commit()
        self.assertEqual(self.push_mode(), "full")

    def test_renaming_documentation_to_source_is_full(self):
        self.run_git("mv", "docs/guide.md", "app2.py")
        self.commit()
        self.assertEqual(self.push_mode(), "full")

    def test_executable_mode_change_is_full(self):
        self.run_git("update-index", "--chmod=+x", "README.md")
        self.run_git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Mode")
        self.assertEqual(self.push_mode(), "full")

    def test_symlink_document_is_full(self):
        (self.root / "docs/link.md").symlink_to("../app.py")
        self.commit()
        self.assertEqual(self.push_mode(), "full")

    def test_zero_missing_invalid_and_unavailable_before_shas_are_full(self):
        self.write("README.md", "# Updated\n")
        self.commit()
        for before in ("0" * 40, "f" * 40, None, "--stat", "HEAD~1"):
            with self.subTest(before=before):
                self.assertEqual(self.push_mode(before=before), "full")
        head = self.run_git("rev-parse", "HEAD")
        self.assertEqual(
            check_changes.classify("push", {"after": head}, head, self.root).mode,
            "full",
        )

    def test_empty_diff_is_full(self):
        self.assertEqual(self.push_mode(), "full")

    def test_manual_unknown_and_malformed_events_are_full(self):
        head = self.run_git("rev-parse", "HEAD")
        for event_name in ("workflow_dispatch", "schedule", "merge_group", ""):
            with self.subTest(event_name=event_name):
                decision = check_changes.classify(event_name, {}, head, self.root)
                self.assertEqual(decision.mode, "full")
        for event in ({}, {"pull_request": None}, {"pull_request": {"base": []}}):
            with self.subTest(event=event):
                decision = check_changes.classify(
                    "pull_request", event, head, self.root
                )
                self.assertEqual(decision.mode, "full")

    def test_checkout_and_push_sha_mismatches_are_full(self):
        self.write("README.md", "# Updated\n")
        self.commit()
        head = self.run_git("rev-parse", "HEAD")
        event = {"before": self.base, "after": head}
        decision = check_changes.classify("push", event, self.base, self.root)
        self.assertEqual(decision.mode, "full")
        self.assertEqual(self.push_mode(after=self.base), "full")

    def test_force_push_still_compares_the_complete_endpoints(self):
        self.write("app.py", "value = 2\n")
        self.commit()
        self.assertEqual(self.push_mode(forced=True), "full")

    def test_pr_uses_merge_base_not_new_source_changes_on_base_branch(self):
        self.run_git("checkout", "--quiet", "-b", "docs-topic")
        self.write("docs/guide.md", "# Topic\n")
        head = self.commit()
        self.run_git("checkout", "--quiet", "main")
        self.write("app.py", "value = 2\n")
        base = self.commit()
        self.run_git(
            "-c", "commit.gpgsign=false", "merge", "--quiet", "--no-ff", "docs-topic"
        )
        merge = self.run_git("rev-parse", "HEAD")
        event = {"pull_request": {"base": {"sha": base}, "head": {"sha": head}}}
        decision = check_changes.classify("pull_request", event, merge, self.root)
        self.assertEqual(decision.mode, "docs")

    def test_pr_includes_earlier_source_commits_and_rejects_unrelated_checkout(self):
        self.write("app.py", "value = 2\n")
        self.commit()
        self.write("README.md", "# Topic\n")
        head = self.commit()
        event = {"pull_request": {"base": {"sha": self.base}, "head": {"sha": head}}}
        decision = check_changes.classify("pull_request", event, head, self.root)
        self.assertEqual(decision.mode, "full")
        self.run_git("checkout", "--quiet", "--detach", self.base)
        decision = check_changes.classify("pull_request", event, self.base, self.root)
        self.assertEqual(decision.mode, "full")

    def test_malformed_raw_diff_and_non_utf8_paths_are_full(self):
        for raw in (b"", b"garbage\0", b":100644 100644 x x M\0README.md", b"x\0y\0"):
            with self.subTest(raw=raw):
                self.assertFalse(check_changes.prose_diff(raw))
        raw = b":100644 100644 x x M\0docs/\xff.md\0"
        with patch.object(check_changes, "git", side_effect=[self.base.encode(), raw]):
            decision = check_changes.classify(
                "push", {"before": self.base, "after": self.base}, self.base, self.root
            )
        self.assertEqual(decision.mode, "full")

    def test_submodule_change_cannot_be_hidden_by_git_configuration(self):
        self.run_git(
            "update-index", "--add", "--cacheinfo", f"160000,{self.base},module"
        )
        self.run_git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Module")
        self.base = self.run_git("rev-parse", "HEAD")
        self.write("README.md", "# Updated\n")
        self.run_git("add", "README.md")
        self.run_git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Prose")
        head = self.run_git("rev-parse", "HEAD")
        self.run_git("update-index", "--cacheinfo", f"160000,{head},module")
        self.run_git(
            "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Module tip"
        )
        self.run_git("config", "diff.ignoreSubmodules", "all")
        self.assertEqual(self.push_mode(), "full")


class DocumentationChecksTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="code-along-docs-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "docs").mkdir()
        (self.root / "README.md").write_text("# Fixture\n")
        (self.root / "docs/existing file.md").write_text("# Existing\n")

    def errors(self, text):
        (self.root / "docs/guide.md").write_text(text)
        return check_changes.local_link_errors(self.root, ["docs/guide.md"])

    def test_existing_relative_encoded_and_reference_targets_pass(self):
        self.assertEqual(
            self.errors(
                "[Root](../README.md#heading)\n"
                "[Encoded](existing%20file.md)\n"
                "[Angle](<existing file.md>)\n"
                "[Reference][root]\n\n[root]: ../README.md\n"
            ),
            [],
        )

    def test_missing_inline_and_reference_targets_fail(self):
        errors = self.errors("[Missing](missing.md)\n\n[ref]: absent.md\n")
        self.assertEqual(len(errors), 2)
        self.assertTrue(errors[0].startswith("docs/guide.md:1:"))
        self.assertTrue(errors[1].startswith("docs/guide.md:3:"))

    def test_remote_links_anchors_and_code_examples_are_not_network_checked(self):
        self.assertEqual(
            self.errors(
                "[Remote](https://example.invalid/missing) [Anchor](#heading)\n"
                "`[Inline example](missing.md)`\n"
                "````markdown\n[Example](missing.md)\n```\n````\n"
                "~~~text\n[ref]: missing.md\n~~~\n"
            ),
            [],
        )

    def test_traversal_and_symlinks_outside_repository_fail(self):
        (self.root / "docs/outside.md").symlink_to(self.root.parent)
        errors = self.errors("[Traversal](../..) [Symlink](outside.md)\n")
        self.assertEqual(len(errors), 2)

    def test_machine_local_file_urls_are_rejected(self):
        self.assertEqual(len(self.errors("[External](file:///private/tmp)\n")), 1)

    def test_empty_documentation_set_fails(self):
        with (
            patch.object(check_changes, "git", return_value=b""),
            self.assertRaisesRegex(RuntimeError, "No tracked documentation"),
        ):
            check_changes.check_docs(self.root)

    def test_main_emits_only_the_fixed_mode_and_propagates_classifier_failure(self):
        event_path = self.root / "event.json"
        output_path = self.root / "output.txt"
        event_path.write_text(json.dumps({"before": "untrusted\nmode=docs"}))
        environment = {
            "GITHUB_EVENT_PATH": str(event_path),
            "GITHUB_OUTPUT": str(output_path),
            "GITHUB_EVENT_NAME": "push",
        }
        with (
            patch.dict(os.environ, environment, clear=True),
            patch("sys.argv", ["check_changes.py"]),
        ):
            check_changes.main()
            self.assertEqual(output_path.read_text(), "mode=full\n")
            with (
                patch.object(
                    check_changes, "classify", side_effect=RuntimeError("Bug")
                ),
                self.assertRaisesRegex(RuntimeError, "Bug"),
            ):
                check_changes.main()
            self.assertEqual(output_path.read_text(), "mode=full\n")


if __name__ == "__main__":
    unittest.main()
