"""Application configuration loaded from environment variables."""

import os
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

# Load environment variables from .env if present.
load_dotenv()


class Config:
    """Base configuration class for Flask."""

    FLASK_SECRET_KEY = os.getenv("FLASK_SECRET_KEY")
    YT_API_KEY = os.getenv("YT_API_KEY")
    DATABASE_URI = os.getenv("DATABASE_URI", "sqlite:///yt_clear_view.db")
    FLASK_PORT = int(os.getenv("FLASK_PORT", "5550"))
    FLASK_HOST = os.getenv("FLASK_HOST", "0.0.0.0")
    FLASK_DEBUG = os.getenv("FLASK_DEBUG", "False").lower() == "true"
    CORS_ORIGINS = os.getenv("CORS_ORIGINS", "")
    COOKIE_SECURE = os.getenv("COOKIE_SECURE")
    if COOKIE_SECURE is None:
        COOKIE_SECURE = not FLASK_DEBUG
    else:
        COOKIE_SECURE = COOKIE_SECURE.lower() == "true"
    SESSION_MAX_AGE_DAYS = int(os.getenv("SESSION_MAX_AGE_DAYS", "90"))

    _env_log_level = os.getenv("LOG_LEVEL")
    if _env_log_level:
        LOG_LEVEL = _env_log_level
    else:
        LOG_LEVEL = "DEBUG" if FLASK_DEBUG else "INFO"
    LOG_FILE = os.getenv("LOG_FILE", "logs/app.log")
    LOG_MAX_SIZE = int(os.getenv("LOG_MAX_SIZE", str(10 * 1024 * 1024)))
    LOG_BACKUP_COUNT = int(os.getenv("LOG_BACKUP_COUNT", "5"))
    APP_TIMEZONE = os.getenv("APP_TIMEZONE", "Europe/Madrid").strip() or "Europe/Madrid"
    ADMIN_USERNAMES = os.getenv("ADMIN_USERNAMES", "")
    ADMIN_BOOTSTRAP_USERNAME = os.getenv("ADMIN_BOOTSTRAP_USERNAME", "")
    ADMIN_BOOTSTRAP_PASSWORD = os.getenv("ADMIN_BOOTSTRAP_PASSWORD", "")
    ADMIN_BOOTSTRAP_DISPLAY_NAME = os.getenv("ADMIN_BOOTSTRAP_DISPLAY_NAME", "")
    ADMIN_FORCE_RESET = os.getenv("ADMIN_FORCE_RESET", "false").lower() == "true"
    ADMIN_RESET_PASSWORD = os.getenv("ADMIN_RESET_PASSWORD", "false").lower() == "true"
    BOOTSTRAP_TIMEOUT_SECONDS = int(os.getenv("BOOTSTRAP_TIMEOUT_SECONDS", "300"))
    SQLITE_METRICS_ENABLED = os.getenv("SQLITE_METRICS_ENABLED", "false").lower() == "true"
    SQLITE_METRICS_SLOW_WRITE_MS = int(os.getenv("SQLITE_METRICS_SLOW_WRITE_MS", "100"))

    # YouTube raised the Shorts length cap from 60s to 3 minutes on 2024-10-15
    # (videos uploaded before that date keep their original classification).
    # See https://support.google.com/youtube/answer/15424877
    SHORTS_MAX_DURATION_SECONDS = int(os.getenv("SHORTS_MAX_DURATION_SECONDS", "180"))

    GUNICORN_WORKERS = int(os.getenv("GUNICORN_WORKERS", "2"))

    YT_DAILY_QUOTA = int(os.getenv("YT_DAILY_QUOTA", "10000"))
    YT_QUOTA_CAP_RATIO = float(os.getenv("YT_QUOTA_CAP_RATIO", "0.8"))
    YT_REFRESH_COST = int(os.getenv("YT_REFRESH_COST", "2"))
    YT_RSS_COMPLETION_COST = int(os.getenv("YT_RSS_COMPLETION_COST", "1"))
    VIDEO_REFRESH_MODE = os.getenv("VIDEO_REFRESH_MODE", "hybrid").strip().lower() or "hybrid"
    MANUAL_REFRESH_RESERVED_QUOTA_RATIO = float(
        os.getenv("MANUAL_REFRESH_RESERVED_QUOTA_RATIO", "0.1")
    )
    MANUAL_REFRESH_FULL_COOLDOWN_SECONDS = int(
        os.getenv("MANUAL_REFRESH_FULL_COOLDOWN_SECONDS", "7200")
    )
    MANUAL_REFRESH_CHANNEL_COOLDOWN_SECONDS = int(
        os.getenv("MANUAL_REFRESH_CHANNEL_COOLDOWN_SECONDS", "1800")
    )
    SCHEDULER_ENABLED = os.getenv("SCHEDULER_ENABLED", "false").lower() == "true"
    SCHEDULER_INTERVAL_SECONDS = int(os.getenv("SCHEDULER_INTERVAL_SECONDS", "60"))
    AUTO_BASIC_CLASSIFICATION_ENABLED = (
        os.getenv("AUTO_BASIC_CLASSIFICATION_ENABLED", "true").lower() == "true"
    )
    AUTO_BASIC_CLASSIFICATION_MAX_RUNS_PER_DAY = int(
        os.getenv("AUTO_BASIC_CLASSIFICATION_MAX_RUNS_PER_DAY", "2")
    )
    AUTO_BASIC_CLASSIFICATION_MIN_INTERVAL_HOURS = int(
        os.getenv("AUTO_BASIC_CLASSIFICATION_MIN_INTERVAL_HOURS", "12")
    )
    BACKFILL_INTERVAL_MINUTES = int(os.getenv("BACKFILL_INTERVAL_MINUTES", "15"))
    BACKFILL_MAX_CHANNELS = int(os.getenv("BACKFILL_MAX_CHANNELS", "50"))

    AUTH_MODE = os.getenv("AUTH_MODE", "local")
    LOCAL_SIGNUP_ENABLED = os.getenv("LOCAL_SIGNUP_ENABLED", "false").lower() == "true"
    AUTH_TOKEN_ENCRYPTION_KEY = os.getenv("AUTH_TOKEN_ENCRYPTION_KEY")
    PASSWORD_POLICY = os.getenv("PASSWORD_POLICY", "strong").strip().lower() or "strong"
    GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
    GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")
    GOOGLE_REDIRECT_URI = os.getenv("GOOGLE_REDIRECT_URI")
    GOOGLE_DEVICE_CLIENT_ID = os.getenv("GOOGLE_DEVICE_CLIENT_ID") or os.getenv("GOOGLE_CLIENT_ID")
    GOOGLE_DEVICE_CLIENT_SECRET = os.getenv("GOOGLE_DEVICE_CLIENT_SECRET") or os.getenv("GOOGLE_CLIENT_SECRET")
    GOOGLE_OAUTH_SCOPES = os.getenv(
        "GOOGLE_OAUTH_SCOPES",
        "openid email profile https://www.googleapis.com/auth/youtube.readonly",
    )
    FRONTEND_URL = os.getenv("FRONTEND_URL", "")
    PASSKEY_RP_NAME = os.getenv("PASSKEY_RP_NAME", "YT Clear View")
    PASSKEY_RP_ID = os.getenv("PASSKEY_RP_ID", "")
    PASSKEY_ORIGIN = os.getenv("PASSKEY_ORIGIN", "")
    PASSKEY_ALLOWED_ORIGINS = os.getenv("PASSKEY_ALLOWED_ORIGINS", "")

    SQLALCHEMY_DATABASE_URI = DATABASE_URI
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    if DATABASE_URI.startswith("sqlite"):
        SQLALCHEMY_ENGINE_OPTIONS = {
            "connect_args": {
                "check_same_thread": False,
                "timeout": 30,
            }
        }

    @staticmethod
    def validate():
        """Validate critical configuration values."""
        if not Config.FLASK_SECRET_KEY:
            raise ValueError("FLASK_SECRET_KEY is required.")
        if not Config.FLASK_DEBUG and not Config.YT_API_KEY:
            raise ValueError("YT_API_KEY is required in production.")

        origins = [origin.strip() for origin in Config.CORS_ORIGINS.split(",") if origin.strip()]
        if not origins:
            raise ValueError("CORS_ORIGINS is required.")
        if "*" in origins:
            raise ValueError("CORS_ORIGINS must be explicit (no wildcard '*').")

        valid_levels = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        if Config.LOG_LEVEL.upper() not in valid_levels:
            raise ValueError("LOG_LEVEL must be one of DEBUG, INFO, WARNING, ERROR, CRITICAL.")
        try:
            ZoneInfo(Config.APP_TIMEZONE)
        except Exception as error:
            raise ValueError("APP_TIMEZONE must be a valid IANA timezone.") from error

        auth_mode = (Config.AUTH_MODE or "local").lower()
        if auth_mode not in ("local", "google"):
            raise ValueError("AUTH_MODE must be 'local' or 'google'.")

        if Config.PASSWORD_POLICY not in {"simple", "strong", "unbreakable"}:
            raise ValueError("PASSWORD_POLICY must be 'simple', 'strong', or 'unbreakable'.")

        if auth_mode == "google":
            missing = []
            if not Config.GOOGLE_CLIENT_ID:
                missing.append("GOOGLE_CLIENT_ID")
            if not Config.GOOGLE_CLIENT_SECRET:
                missing.append("GOOGLE_CLIENT_SECRET")
            if not Config.GOOGLE_REDIRECT_URI:
                missing.append("GOOGLE_REDIRECT_URI")
            if not Config.FRONTEND_URL:
                missing.append("FRONTEND_URL")
            if missing:
                raise ValueError(f"Missing Google OAuth config: {', '.join(missing)}")

        if Config.SESSION_MAX_AGE_DAYS <= 0:
            raise ValueError("SESSION_MAX_AGE_DAYS must be positive.")

        if Config.YT_DAILY_QUOTA <= 0:
            raise ValueError("YT_DAILY_QUOTA must be positive.")
        if Config.VIDEO_REFRESH_MODE not in {"hybrid", "rss_preferred", "api_only"}:
            raise ValueError("VIDEO_REFRESH_MODE must be 'hybrid', 'rss_preferred', or 'api_only'.")
        if not 0 < Config.YT_QUOTA_CAP_RATIO <= 1:
            raise ValueError("YT_QUOTA_CAP_RATIO must be between 0 and 1.")
        if not 0 <= Config.MANUAL_REFRESH_RESERVED_QUOTA_RATIO < 1:
            raise ValueError("MANUAL_REFRESH_RESERVED_QUOTA_RATIO must be between 0 and 1.")
