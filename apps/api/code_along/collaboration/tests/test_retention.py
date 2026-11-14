import hashlib
import io
import uuid
from collections.abc import Iterator
from datetime import timedelta
from unittest.mock import patch

import pytest
from config.celery import app
from django.apps import apps
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import DatabaseError, connection, models, transaction
from django.db.models.deletion import ProtectedError
from django.utils import timezone

from code_along.collaboration import retention, tasks
from code_along.collaboration.models import CheckpointReceipt, DocumentState
from code_along.collaboration.tests.catalog import ensure_runtime_catalog
from code_along.projects import services as projects
from code_along.projects.models import Project
from code_along.workspaces import services as workspaces
from code_along.workspaces.tests.test_workspaces import person


def fixture_document() -> tuple[Project, DocumentState]:
    ensure_runtime_catalog()
    owner = person("retention-owner-" + uuid.uuid4().hex[:8])
    workspace = workspaces.create_workspace(owner, "Receipt group")
    project = projects.create_project(owner, workspace.id, "Retained source")
    binary = b"\x00\x00"
    state = DocumentState.objects.create(
        document=project.documents.get(),
        generation=1,
        binary_state=binary,
        durable_revision=1,
        state_sha256=hashlib.sha256(binary).hexdigest(),
    )
    return project, state


def receipts(
    state: DocumentState, count: int, *, age: timedelta = timedelta()
) -> list[CheckpointReceipt]:
    created = timezone.now() - age
    rows = [
        CheckpointReceipt(
            document_id=state.document_id,
            generation=1,
            client_session_id=uuid.uuid4(),
            checkpoint_id=uuid.uuid4(),
            observed_counter=0,
            request_sha256="a" * 64,
            durable_revision=1,
            state_sha256=state.state_sha256,
            recorded_at=created + timedelta(microseconds=index),
        )
        for index in range(count)
    ]
    CheckpointReceipt.objects.bulk_create(rows)
    return rows


def test_retention_policy_is_fixed_and_rejects_naive_clock_before_database() -> None:
    assert (
        retention.RECENT_RECEIPTS,
        retention.HARD_RECEIPT_CAPACITY,
        retention.MAX_CANDIDATES,
        retention.MAX_DOCUMENTS,
    ) == (2048, 4096, 512, 16)
    assert retention.RECEIPT_LIFETIME == timedelta(hours=24)
    with pytest.raises(ValueError, match="aware_retention_time_required"):
        retention.prune_checkpoint_receipts(now=timezone.now().replace(tzinfo=None))


def test_maintenance_task_has_no_arguments_explicit_app_and_bounded_errors() -> None:
    assert (
        tasks.prune_checkpoint_receipts.name
        == "code_along.collaboration.prune_checkpoint_receipts"
    )
    assert tasks.prune_checkpoint_receipts.app is app
    with patch.object(
        tasks, "prune", return_value=retention.RetentionStats(deleted=2)
    ) as run:
        assert tasks.prune_checkpoint_receipts.run()["deleted"] == 2
        run.assert_called_once_with(apply=True)
    with patch.object(tasks, "prune", side_effect=retention.RetentionUnavailable()):
        assert tasks.prune_checkpoint_receipts.run() == {"unavailable": 1}
    with pytest.raises(TypeError):
        tasks.prune_checkpoint_receipts.run("unexpected")  # type: ignore[call-arg]


def test_management_command_previews_and_only_explicit_apply_can_delete() -> None:
    with patch(
        "code_along.collaboration.management.commands.prune_checkpoint_receipts.prune_checkpoint_receipts",
        return_value=retention.RetentionStats(eligible=1),
    ) as run:
        output = io.StringIO()
        call_command("prune_checkpoint_receipts", stdout=output)
        run.assert_called_once_with(apply=False)
        assert "Preview" in output.getvalue() and "eligible 1" in output.getvalue()
        run.reset_mock()
        call_command("prune_checkpoint_receipts", "--apply", stdout=io.StringIO())
        run.assert_called_once_with(apply=True)
    with patch(
        "code_along.collaboration.management.commands.prune_checkpoint_receipts.prune_checkpoint_receipts",
        side_effect=retention.RetentionUnavailable(),
    ):
        with pytest.raises(
            CommandError, match="Checkpoint receipt retention unavailable"
        ):
            call_command("prune_checkpoint_receipts", stdout=io.StringIO())


@pytest.mark.postgres
@pytest.mark.django_db(transaction=True)
class TestReceiptRetention:
    def test_preview_retains_every_byte_then_apply_expires_old_receipts_only(
        self,
    ) -> None:
        project, state = fixture_document()
        old = receipts(state, 2, age=timedelta(hours=25))
        recent = receipts(state, 2)
        before = bytes(state.binary_state), state.state_sha256, state.durable_revision
        assert retention.prune_checkpoint_receipts().counts() == {
            "documents": 1,
            "examined": 2,
            "eligible": 2,
            "protected": 0,
            "deleted": 0,
        }
        assert CheckpointReceipt.objects.count() == 4
        applied = retention.prune_checkpoint_receipts(apply=True)
        assert applied.deleted == 2
        assert not CheckpointReceipt.objects.filter(
            id__in=[row.id for row in old]
        ).exists()
        assert set(CheckpointReceipt.objects.values_list("id", flat=True)) == {
            row.id for row in recent
        }
        state.refresh_from_db()
        assert (
            bytes(state.binary_state),
            state.state_sha256,
            state.durable_revision,
        ) == before
        assert project.files.get().initial_source == projects.STARTER
        assert not project.revisions.exists() and not project.chat_messages.exists()

    def test_recent_target_keeps_exact_newest2048_and_pass_is_bounded512(self) -> None:
        _, state = fixture_document()
        rows = receipts(state, 2561)
        first = retention.prune_checkpoint_receipts(apply=True)
        assert first.examined == first.deleted == 512
        assert CheckpointReceipt.objects.count() == 2049
        second = retention.prune_checkpoint_receipts(apply=True)
        assert second.deleted == 1
        assert set(CheckpointReceipt.objects.values_list("id", flat=True)) == {
            row.id for row in rows[-2048:]
        }
        assert retention.prune_checkpoint_receipts(apply=True).examined == 0

    def test_database_errors_are_bounded_and_never_include_driver_or_source_details(
        self,
    ) -> None:
        with patch.object(
            connection, "cursor", side_effect=DatabaseError("PRIVATE_DRIVER_SOURCE")
        ):
            with pytest.raises(retention.RetentionUnavailable) as error:
                retention.prune_checkpoint_receipts(apply=True)
        assert str(error.value) == "receipt_retention_unavailable"

    def test_maintenance_rejects_an_existing_transaction_without_changing_it(
        self,
    ) -> None:
        with transaction.atomic():
            with pytest.raises(retention.RetentionUnavailable):
                retention.prune_checkpoint_receipts(apply=True)
            assert connection.in_atomic_block


@pytest.mark.postgres
@pytest.mark.django_db(transaction=True)
def test_skip_locked_document_does_not_block_or_prune_it() -> None:
    import psycopg

    _, state = fixture_document()
    receipts(state, 1, age=timedelta(days=2))
    database = connection.settings_dict
    with psycopg.connect(
        dbname=database["NAME"],
        host=database["HOST"],
        port=database["PORT"],
        user=database["USER"],
    ) as other:
        other.execute(
            "SELECT document_id FROM collaboration_documentstate WHERE document_id=%s FOR UPDATE",
            [state.document_id],
        )
        assert retention.prune_checkpoint_receipts(apply=True).documents == 0
        assert CheckpointReceipt.objects.count() == 1
    assert retention.prune_checkpoint_receipts(apply=True).deleted == 1


@pytest.fixture
def future_provenance(request: pytest.FixtureRequest) -> Iterator[type[models.Model]]:
    # A temporary test-only FK exercises the actual Collector/PROTECT boundary.
    class ReceiptProvenance(models.Model):
        receipt = models.ForeignKey(
            CheckpointReceipt,
            on_delete=models.DO_NOTHING
            if getattr(request, "param", "protect") == "nothing"
            else models.PROTECT,
        )

        class Meta:
            app_label = "collaboration"

    with connection.schema_editor() as editor:
        editor.create_model(ReceiptProvenance)
    try:
        yield ReceiptProvenance
    finally:
        with connection.schema_editor() as editor:
            editor.delete_model(ReceiptProvenance)
        del apps.all_models["collaboration"]["receiptprovenance"]
        apps.clear_cache()


@pytest.mark.postgres
@pytest.mark.django_db(transaction=True)
def test_real_protected_provenance_retains_receipt_while_unreferenced_peer_expires(
    future_provenance: type[models.Model],
) -> None:
    _, state = fixture_document()
    kept, removable = receipts(state, 2, age=timedelta(days=2))
    future_provenance._default_manager.create(receipt=kept)
    with pytest.raises(ProtectedError):
        kept.delete()
    result = retention.prune_checkpoint_receipts(apply=True)
    assert result.protected == result.deleted == 1
    assert CheckpointReceipt.objects.filter(id=kept.id).exists()
    assert not CheckpointReceipt.objects.filter(id=removable.id).exists()
    assert future_provenance._default_manager.count() == 1


@pytest.mark.postgres
@pytest.mark.django_db(transaction=True)
@pytest.mark.parametrize("future_provenance", ["nothing"], indirect=True)
def test_deferred_do_nothing_reference_is_retained_without_rolling_back_other_pruning(
    future_provenance: type[models.Model],
) -> None:
    _, state = fixture_document()
    kept, removable = receipts(state, 2, age=timedelta(days=2))
    future_provenance._default_manager.create(receipt=kept)
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT condeferrable,condeferred FROM pg_constraint WHERE conrelid=%s::regclass AND contype='f'",
            [future_provenance._meta.db_table],
        )
        assert cursor.fetchone() == (True, True)
    result = retention.prune_checkpoint_receipts(apply=True)
    assert result.protected == result.deleted == 1
    assert CheckpointReceipt.objects.filter(id=kept.id).exists()
    assert not CheckpointReceipt.objects.filter(id=removable.id).exists()
    assert future_provenance._default_manager.count() == 1
    assert connection.get_autocommit()
