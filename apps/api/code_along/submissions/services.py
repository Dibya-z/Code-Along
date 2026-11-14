"""Atomic chosen-source capture. No CRDT recapture or learner-code execution."""

import json
import uuid
from dataclasses import dataclass
from typing import Any

from django.db import transaction
from django.db.models import Max
from django.shortcuts import get_object_or_404
from django.utils import timezone

from code_along.accounts.models import User
from code_along.collaboration.profiles import public_display_name
from code_along.events.contracts import utc
from code_along.learning.contracts import canonical, digest
from code_along.learning.models import AssignmentWork
from code_along.learning.notifications import LearningChanges, flush_learning_changes
from code_along.learning.participation_services import (
    active_verified,
    current_member,
    lock_learning,
)
from code_along.learning.policies import is_teacher
from code_along.learning.work_services import subject_members
from code_along.projects.models import (
    Project,
    ProjectRevision,
    RevisionFile,
    RuntimeProfile,
)
from code_along.projects.revision_contract import HELPER_RELEASE

from .errors import SubmissionError
from .evidence import parse_evidence, require_pinned_evidence
from .manifest import (
    SubmissionManifest,
    SubmissionManifestError,
    validate_submission_manifest,
)
from .models import (
    Submission,
    SubmissionAssignmentUsage,
    SubmissionParticipant,
    SubmissionWorkspaceUsage,
)
from .policies import require_new_submit
from .selectors import readable_submission


@dataclass(frozen=True, slots=True)
class PreparedSubmission:
    nonce: uuid.UUID
    manifest: SubmissionManifest
    artifact_sha256: str
    evidence_json: str
    request_sha256: str

    def evidence(self) -> dict[str, Any] | None:
        value: dict[str, Any] | None = json.loads(self.evidence_json)
        return value


def prepare(body: object, work_id: uuid.UUID) -> PreparedSubmission:
    if not isinstance(body, dict) or set(body) != {
        "client_request_id",
        "manifest",
        "practice",
    }:
        raise SubmissionError(
            "invalid_submission_request",
            "Use the exact submission request fields.",
            status=400,
        )
    try:
        nonce = uuid.UUID(body["client_request_id"])
        if (
            str(nonce) != body["client_request_id"]
            or nonce.variant != uuid.RFC_4122
            or nonce.version not in range(1, 9)
        ):
            raise ValueError
    except (ValueError, TypeError, AttributeError):
        raise SubmissionError(
            "invalid_submission_request",
            "Use a canonical request identity.",
            status=400,
        ) from None
    try:
        manifest = validate_submission_manifest(body["manifest"])
        artifact = manifest.as_revision_manifest(HELPER_RELEASE)
    except SubmissionManifestError:
        raise SubmissionError(
            "invalid_submission_manifest",
            "The chosen source manifest is invalid.",
            status=400,
        ) from None
    evidence = parse_evidence(body["practice"], manifest.sha256)
    normalized = [
        "code-along.submission-request",
        1,
        str(work_id),
        str(nonce),
        manifest.as_manifest(),
        evidence,
    ]
    return PreparedSubmission(
        nonce,
        manifest,
        artifact["sha256"],
        canonical(evidence).decode("utf-8"),
        digest(normalized),
    )


def require_structure(
    work: AssignmentWork, project: Project, manifest: SubmissionManifest
) -> None:
    current = sorted(
        project.files.filter(deleted_at__isnull=True).select_related("document"),
        key=lambda file: file.path,
    )
    expected = [
        (file.id, file.document.id, file.generation, file.path) for file in current
    ]
    chosen = [
        (file.file_id, file.document_id, file.generation, file.path)
        for file in manifest.files
    ]
    if (
        manifest.project_id != project.id
        or project.metadata_version != manifest.metadata_version
        or project.entrypoint_file_id != manifest.entrypoint_file_id
        or expected != chosen
    ):
        raise SubmissionError(
            "submission_structure_changed",
            "Project structure changed. Keep this source and review a new choice explicitly.",
        )
    if manifest.runtime.as_dict() != work.assignment_version.runtime_identity:
        raise SubmissionError(
            "submission_runtime_changed",
            "The chosen runtime differs from this work's pinned runtime.",
        )


def metadata_charge(
    submission: Submission,
    revision: ProjectRevision,
    files: list[RevisionFile],
    participants: list[SubmissionParticipant],
) -> int:
    # Fixed version-one charge includes all retained scalar/JSON provenance and
    # file metadata, excluding only source strings (charged separately).
    data: dict[str, Any] = {
        "version": 1,
        "submission": {},
        "revision": {},
        "participants": [],
        "files": [],
    }
    for record, key in ((submission, "submission"), (revision, "revision")):
        for field in record._meta.concrete_fields:
            if field.name in {"metadata_bytes", "created_at"}:
                continue
            value = getattr(record, field.attname)
            if isinstance(value, uuid.UUID):
                value = str(value)
            if hasattr(value, "isoformat"):
                value = utc(value)
            data[key][field.attname] = value
    data["revision"]["created_at"] = utc(submission.submitted_at)
    data["participants"] = [
        {
            "id": str(p.id),
            "submission_id": str(p.submission_id),
            "assignment_id": str(p.assignment_id),
            "assignment_version_id": str(p.assignment_version_id),
            "participation_id": str(p.participation_id),
            "user_id": str(p.user_id),
            "display_name": p.display_name,
            "attempt_number": p.attempt_number,
        }
        for p in participants
    ]
    data["files"] = [
        {
            "id": str(f.id),
            "revision_id": str(f.revision_id),
            "file_id": str(f.file_id),
            "document_id": str(f.document_id),
            "generation": f.generation,
            "path": f.path,
            "source_sha256": f.source_sha256,
            "source_bytes": f.source_bytes,
        }
        for f in files
    ]
    return len(canonical(data))


@transaction.atomic
def submit(
    user: User,
    session_key: str | None,
    assignment_id: uuid.UUID,
    work_id: uuid.UUID,
    prepared: PreparedSubmission,
) -> tuple[Submission, bool]:
    assignment = lock_learning(assignment_id)
    current = current_member(user, session_key, assignment)
    original = Submission.objects.filter(
        assignment=assignment, author=current, client_request_id=prepared.nonce
    ).first()
    if original is not None:
        # Private history authority precedes new policy, but nonce knowledge is
        # insufficient. Use the historical frozen subject, never WorkMember.
        original = readable_submission(assignment, original.id, current)
        if (
            original.request_sha256 != prepared.request_sha256
            or original.work_id != work_id
        ):
            raise SubmissionError(
                "submission_nonce_conflict",
                "This request identity already binds a different submission.",
            )
        current_member(user, session_key, assignment)
        return original, False
    work = get_object_or_404(
        AssignmentWork.objects.select_for_update(of=("self",)).select_related(
            "assignment_version", "participation", "team"
        ),
        assignment=assignment,
        id=work_id,
    )
    work.assignment, work.workspace = assignment, assignment.workspace
    if (
        not is_teacher(assignment.workspace, current)
        and not work.members.filter(user=current).exists()
        and not any(member.user_id == current.id for member in subject_members(work))
    ):
        from rest_framework.exceptions import NotFound

        raise NotFound("Learning work unavailable.")
    if not any(member.user_id == current.id for member in subject_members(work)):
        raise SubmissionError(
            "submission_participation_unavailable",
            "Current eligible participation is required for a new submission.",
        )
    project = (
        Project.objects.select_for_update()
        .select_related("runtime_profile")
        .get(id=work.project_id)
    )
    project.workspace = assignment.workspace
    project.runtime_profile = RuntimeProfile.objects.select_for_update().get(
        id=project.runtime_profile_id
    )
    now = timezone.now()
    require_new_submit(
        work, current, project, now, source_bytes=prepared.manifest.source_bytes
    )
    require_structure(work, project, prepared.manifest)
    evidence = prepared.evidence()
    require_pinned_evidence(evidence, work.assignment_version, prepared.manifest.sha256)
    members = subject_members(work)
    assignment_usage, _ = SubmissionAssignmentUsage.objects.get_or_create(
        assignment=assignment, defaults={"workspace": assignment.workspace}
    )
    workspace_usage, _ = SubmissionWorkspaceUsage.objects.get_or_create(
        workspace=assignment.workspace
    )
    number = assignment_usage.count + 1
    attempts = {
        member.user_id: (
            SubmissionParticipant.objects.filter(
                assignment_version=work.assignment_version, user_id=member.user_id
            ).aggregate(value=Max("attempt_number"))["value"]
            or 0
        )
        + 1
        for member in members
    }
    sequence = (
        (
            Submission.objects.filter(
                assignment_version=work.assignment_version, team_id=work.team_id
            ).aggregate(value=Max("subject_attempt_number"))["value"]
            or 0
        )
        + 1
        if work.team_id
        else attempts[current.id]
    )
    submission_id = uuid.uuid4()
    revision = ProjectRevision(
        id=uuid.uuid4(),
        project=project,
        author=current,
        author_display_name=public_display_name(current.display_name),
        client_request_id=prepared.nonce,
        name=f"Submission {number}",
        artifact_scope="submission",
        provenance="client_submitted_snapshot",
        manifest_sha256=prepared.artifact_sha256,
        metadata_version=prepared.manifest.metadata_version,
        entrypoint_file_id=prepared.manifest.entrypoint_file_id,
        runtime_profile=project.runtime_profile,
        runtime_identity=work.assignment_version.runtime_identity,
        runtime_manifest=work.assignment_version.runtime_manifest,
        helper_release=work.assignment_version.helper_release,
        source_bytes=prepared.manifest.source_bytes,
    )
    record = Submission(
        id=submission_id,
        assignment=assignment,
        workspace=assignment.workspace,
        work=work,
        assignment_version=work.assignment_version,
        project=project,
        revision=revision,
        author=current,
        author_display_name=revision.author_display_name,
        client_request_id=prepared.nonce,
        request_sha256=prepared.request_sha256,
        source_manifest_sha256=prepared.manifest.sha256,
        stdin_mode=prepared.manifest.stdin_mode,
        practice=evidence,
        assignment_submission_number=number,
        subject_attempt_number=sequence,
        team_id=work.team_id,
        team_roster_revision=work.team_roster_revision,
        submitted_at=now,
        participant_count=len(members),
    )
    frozen = [
        SubmissionParticipant(
            submission=record,
            assignment=assignment,
            assignment_version=work.assignment_version,
            participation=member,
            user_id=member.user_id,
            display_name=public_display_name(member.user.display_name),
            attempt_number=attempts[member.user_id],
        )
        for member in members
    ]
    files = [
        RevisionFile(
            revision=revision,
            file_id=f.file_id,
            document_id=f.document_id,
            generation=f.generation,
            path=f.path,
            source=f.source,
            source_sha256=f.sha256,
            source_bytes=f.source_bytes,
        )
        for f in prepared.manifest.files
    ]
    record.metadata_bytes = metadata_charge(record, revision, files, frozen)
    if record.metadata_bytes > 16384:
        raise SubmissionError(
            "assignment_submission_capacity",
            "This frozen submission exceeds the retained metadata budget.",
        )
    # The last server clock and actual current account/session policy, under the
    # same domain locks, decides new admission. Pure text changes remain valid.
    record.submitted_at = timezone.now()
    current = current_member(user, session_key, assignment)
    require_new_submit(
        work,
        current,
        project,
        record.submitted_at,
        source_bytes=prepared.manifest.source_bytes,
        metadata_bytes=record.metadata_bytes,
    )
    require_structure(work, project, prepared.manifest)
    revision.save(force_insert=True)
    RevisionFile.objects.bulk_create(files)
    record.save(force_insert=True)
    SubmissionParticipant.objects.bulk_create(frozen)
    for usage in (assignment_usage, workspace_usage):
        usage.count += 1
        usage.source_bytes += prepared.manifest.source_bytes
        usage.metadata_bytes += record.metadata_bytes
        usage.save(update_fields=["count", "source_bytes", "metadata_bytes"])
    signals = LearningChanges()
    signals.add(assignment.id, [member.user_id for member in frozen])
    flush_learning_changes(signals)
    # Account/password/email changes need not acquire workspace locks. Recheck
    # every frozen peer after writes without counting this new attempt twice.
    expected_subject = {(member.participation_id, member.user_id) for member in frozen}
    actual_subject = {(member.id, member.user_id) for member in subject_members(work)}
    if expected_subject != actual_subject or any(
        not active_verified(assignment.workspace, member.user_id) for member in frozen
    ):
        raise SubmissionError(
            "submission_participation_unavailable",
            "A frozen participant is no longer eligible for this submission.",
        )
    current_member(user, session_key, assignment)
    return record, True
