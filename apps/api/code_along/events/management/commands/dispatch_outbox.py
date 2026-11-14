from typing import Any

from django.core.management.base import BaseCommand, CommandError

from code_along.events.dispatcher import DispatchUnavailable, dispatch_batch


class Command(BaseCommand):
    help = "Publish one bounded batch of committed outbox rows. Publication is not a read receipt."

    def handle(self, *args: Any, **options: Any) -> None:
        try:
            counts = dispatch_batch().counts()
        except DispatchUnavailable:
            raise CommandError("Outbox dispatcher unavailable.") from None
        self.stdout.write(
            f"Claimed {counts['claimed']}; published {counts['published']}; "
            f"retrying {counts['retried']}; ownership lost {counts['lost']}."
        )
