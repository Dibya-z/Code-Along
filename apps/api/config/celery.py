"""Trusted notifications and bounded metadata maintenance, never learner Python."""

import os
import ssl

from celery import Celery
from django.conf import settings
from kombu.entity import Queue

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.production")


def create_app(broker: str | None) -> Celery:
    app = Celery(
        "code_along",
        include=["code_along.events.tasks", "code_along.collaboration.tasks"],
        set_as_current=False,
    )
    app.config_from_object("django.conf:settings", namespace="CELERY")
    app.conf.update(
        # A missing setting must never select Celery's implicit AMQP broker.
        broker_url=broker or "disabled://",
        result_backend=None,
        accept_content=["json"],
        task_serializer="json",
        result_serializer="json",
        event_serializer="json",
        task_ignore_result=True,
        task_store_errors_even_if_ignored=False,
        task_acks_late=True,
        task_reject_on_worker_lost=True,
        task_publish_retry=False,
        task_default_queue="code_along.events",
        task_queues=(Queue("code_along.events"),),
        task_create_missing_queues=False,
        worker_prefetch_multiplier=1,
        worker_enable_remote_control=False,
        broker_pool_limit=2,
        broker_connection_timeout=2,
        broker_connection_retry_on_startup=False,
        broker_connection_retry=True,
        broker_connection_max_retries=3,
        broker_transport_options={
            "global_keyprefix": "code_along:jobs:",
            "socket_connect_timeout": 2,
            "socket_timeout": 2,
            "retry_on_timeout": False,
            "visibility_timeout": 60,
        },
        broker_use_ssl={"ssl_cert_reqs": ssl.CERT_REQUIRED, "ssl_check_hostname": True}
        if broker and broker.startswith("rediss://")
        else None,
        timezone="UTC",
        enable_utc=True,
        beat_schedule={
            "dispatch-outbox": {
                "task": "code_along.events.dispatch_outbox",
                "schedule": 2.0,
                "options": {"expires": 5},
            },
            "prune-checkpoint-receipts": {
                "task": "code_along.collaboration.prune_checkpoint_receipts",
                "schedule": 15.0,
                "options": {"expires": 10},
            },
        },
    )
    return app


app = create_app(settings.CELERY_BROKER_URL)
