# Generated by Django 3.0.3 on 2020-04-06 17:13

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("posthog", "0038_migrate_actions_to_precalculate_events"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="email_opt_in",
            field=models.BooleanField(default=False),
        ),
    ]
