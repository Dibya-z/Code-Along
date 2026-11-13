from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("projects", "0004_collaborationdocument_document_id_generation_pair")
    ]
    operations = [
        migrations.AddConstraint(
            model_name="collaborationdocument",
            constraint=models.UniqueConstraint(
                fields=("id", "project", "generation"),
                name="document_project_generation",
            ),
        )
    ]
