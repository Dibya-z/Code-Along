from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("collaboration", "0004_share_parent_constraints")]

    operations = [
        migrations.RunSQL(
            sql="""
            CREATE FUNCTION public.checkpoint_receipt_capacity_guard() RETURNS trigger
            LANGUAGE plpgsql SET search_path = pg_catalog AS $$
            BEGIN
                PERFORM document_id FROM public.collaboration_documentstate
                    WHERE document_id = NEW.document_id FOR UPDATE;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'checkpoint_receipt_document_state'
                        USING ERRCODE = '23503', CONSTRAINT = 'checkpoint_receipt_document_state';
                END IF;
                IF (SELECT count(*) FROM public.collaboration_checkpointreceipt
                    WHERE document_id = NEW.document_id) >= 4096 THEN
                    RAISE EXCEPTION 'checkpoint_receipt_capacity'
                        USING ERRCODE = '54000', CONSTRAINT = 'checkpoint_receipt_capacity';
                END IF;
                RETURN NEW;
            END;
            $$;
            CREATE TRIGGER checkpoint_receipt_capacity
                BEFORE INSERT ON public.collaboration_checkpointreceipt
                FOR EACH ROW EXECUTE FUNCTION public.checkpoint_receipt_capacity_guard();
            """,
            reverse_sql="""
            DROP TRIGGER checkpoint_receipt_capacity ON public.collaboration_checkpointreceipt;
            DROP FUNCTION public.checkpoint_receipt_capacity_guard();
            """,
        )
    ]
