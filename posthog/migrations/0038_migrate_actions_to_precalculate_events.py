# Generated by Django 3.0.3 on 2020-04-03 09:32

from django.db import migrations, models


def migrate_to_precalculate_actions(apps, schema_editor):
    pass


def rollback(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("posthog", "0037_action_step_url_matching_can_be_null_20200402_1351"),
    ]

    operations = [
        migrations.AddField(
            model_name="action",
            name="events",
            field=models.ManyToManyField(blank=True, to="posthog.Event"),
        ),
        migrations.RunPython(migrate_to_precalculate_actions, rollback),
    ]
