"""Application factory for YT Clear View."""

import os
from flask import Flask

from .config import Config
from .extensions import db, init_extensions
from .logging.logger import configure_logging, get_logger, set_runtime_log_level, set_runtime_log_timezone
from .middleware.error_handler import register_error_handlers
from .migrations import (
    ensure_category_schema,
    ensure_channel_category_schema,
    ensure_channel_classification_columns,
    ensure_channel_schema,
    ensure_enrich_settings_columns,
    ensure_login_pairing_schema,
    ensure_quota_event_schema,
    ensure_refresh_job_schema,
    ensure_site_settings_schema,
    ensure_user_channel_rating_columns,
    ensure_user_device_schema,
    ensure_user_passkey_schema,
    ensure_user_session_schema,
    ensure_user_channel_schema,
    ensure_user_settings_schema,
    ensure_user_schema,
    ensure_video_progress_schema,
    ensure_video_schema,
)
from .routes import register_routes
from .services.admin_bootstrap import (
    apply_admin_password_reset_if_requested,
    apply_admin_recovery_if_requested,
    is_bootstrap_required,
    reset_bootstrap_window,
)
from .services.refresh_jobs import recover_interrupted_refresh_jobs
from .services.scheduler import start_scheduler
from .services.site_settings import get_site_log_level
from .services.site_settings import get_refresh_schedule_timezone
from .services.sqlite_metrics import initialize_sqlite_metrics


def create_app(config_class=Config):
    """Create and configure the Flask application."""
    app = Flask(__name__)
    app.config.from_object(config_class)
    if "APP_TIMEZONE" not in app.config:
        app.config["APP_TIMEZONE"] = getattr(config_class, "APP_TIMEZONE", Config.APP_TIMEZONE)
    app.config["SECRET_KEY"] = app.config.get("SECRET_KEY") or app.config.get("FLASK_SECRET_KEY")
    # Only expose a backend build identifier when deployment sets one explicitly.
    # Falling back to a startup timestamp makes multi-worker Gunicorn instances
    # look like "new versions" to the frontend because each worker gets a
    # different value.
    app.config["BACKEND_BUILD_ID"] = os.getenv("YTCV_BACKEND_BUILD_ID")

    # Validate configuration early.
    config_class.validate()

    # Configure logging before initializing extensions.
    configure_logging(
        app.config["LOG_LEVEL"],
        app.config["LOG_FILE"],
        app.config["LOG_MAX_SIZE"],
        app.config["LOG_BACKUP_COUNT"],
        app.config["APP_TIMEZONE"],
    )

    # Initialize Flask extensions.
    init_extensions(app)
    initialize_sqlite_metrics(
        enabled=app.config.get("SQLITE_METRICS_ENABLED", False),
        slow_write_ms=app.config.get("SQLITE_METRICS_SLOW_WRITE_MS", 100),
    )

    # Register routes and error handlers.
    register_routes(app)
    register_error_handlers(app)

    # Create database tables on first run.
    with app.app_context():
        db.create_all()
        ensure_user_schema()
        ensure_user_settings_schema()
        ensure_quota_event_schema()
        ensure_refresh_job_schema()
        ensure_enrich_settings_columns()
        ensure_user_device_schema()
        ensure_user_passkey_schema()
        ensure_user_session_schema()
        ensure_login_pairing_schema()
        ensure_site_settings_schema()
        ensure_user_channel_schema()
        ensure_channel_schema()
        ensure_video_schema()
        ensure_video_progress_schema()
        # Category system migrations
        ensure_category_schema()
        ensure_channel_category_schema()
        ensure_channel_classification_columns()
        ensure_user_channel_rating_columns()
        apply_admin_recovery_if_requested()
        apply_admin_password_reset_if_requested()
        if is_bootstrap_required():
            reset_bootstrap_window()
        recover_interrupted_refresh_jobs()
        app.config["APP_TIMEZONE"] = set_runtime_log_timezone(get_refresh_schedule_timezone())
        set_runtime_log_level(get_site_log_level(app.config["LOG_LEVEL"]))
        os.makedirs(os.path.join(app.instance_path, "channel_thumbnails"), exist_ok=True)

    logger = get_logger(__name__)
    logger.info("Application initialized.", extra={"tracking_id": "SYSTEM"})

    start_scheduler(app)

    return app
