from argparse import ArgumentParser
from typing import Any

from django.core.management.base import BaseCommand, CommandError

from code_along.collaboration.retention import (
    RetentionUnavailable,
    prune_checkpoint_receipts,
)


class Command(BaseCommand):
    help = "Preview bounded checkpoint receipt retention; --apply deletes only unreferenced eligible receipts."

    def add_arguments(self, parser: ArgumentParser) -> None:
        parser.add_argument(
            "--apply",
            action="store_true",
            help="Apply one bounded receipt-maintenance pass.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        try:
            counts = prune_checkpoint_receipts(apply=options["apply"]).counts()
        except RetentionUnavailable:
            raise CommandError("Checkpoint receipt retention unavailable.") from None
        mode = "Applied" if options["apply"] else "Preview"
        self.stdout.write(
            f"{mode}: documents {counts['documents']}; examined {counts['examined']}; eligible {counts['eligible']}; protected {counts['protected']}; deleted {counts['deleted']}."
        )
