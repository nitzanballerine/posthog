# Generated by Django 3.2.15 on 2022-10-31 16:21

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("posthog", "0274_add_plugin_icon_and_rewrite_urls"),
    ]

    operations = [
        migrations.AddField(
            model_name="organization",
            name="usage",
            field=models.JSONField(blank=True, null=True),
        ),
    ]
