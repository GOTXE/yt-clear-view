"""Helpers for admin bootstrap, persistence, and recovery."""

from __future__ import annotations

import secrets
from datetime import datetime

from flask import current_app

from app.extensions import db
from app.logging.logger import get_logger
from app.models import User, SiteSetting
from app.services.auth_security import clear_session_token
from app.utils.time import utc_now

BOOTSTRAP_WINDOW_STARTED_AT_KEY = "bootstrap_window_started_at"
DEFAULT_BOOTSTRAP_TIMEOUT_SECONDS = 300  # 5 minutes


def _get_bootstrap_timeout() -> int:
    """Return the configured bootstrap timeout in seconds."""
    return int(
        current_app.config.get("BOOTSTRAP_TIMEOUT_SECONDS", DEFAULT_BOOTSTRAP_TIMEOUT_SECONDS)
    )


def has_admin_user() -> bool:
    """Return whether at least one active admin account exists."""
    return db.session.query(User.id).filter(User.is_admin.is_(True)).first() is not None


def is_bootstrap_required() -> bool:
    """Return whether the application still needs its first admin account."""
    return not has_admin_user()


def reset_bootstrap_window() -> None:
    """Reset the bootstrap window timer.

    Called on app startup when no admin exists.  Each container restart
    gives a fresh window.
    """
    logger = get_logger(__name__)
    try:
        now_iso = utc_now().isoformat()
        record = SiteSetting.query.filter_by(
            setting_key=BOOTSTRAP_WINDOW_STARTED_AT_KEY
        ).first()
        if record:
            record.setting_value = now_iso
        else:
            record = SiteSetting(
                setting_key=BOOTSTRAP_WINDOW_STARTED_AT_KEY,
                setting_value=now_iso,
            )
            db.session.add(record)
        db.session.commit()
    except Exception as exc:
        db.session.rollback()
        logger.warning(
            "Could not persist bootstrap window timestamp: %s",
            exc,
            extra={"tracking_id": "SYSTEM"},
        )
        return

    timeout = _get_bootstrap_timeout()
    logger.info(
        "Bootstrap window opened (%ds timeout).",
        timeout,
        extra={"tracking_id": "SYSTEM"},
    )


def get_bootstrap_window_info() -> dict:
    """Return bootstrap window timing information.

    Returns dict with keys:
        started_at: ISO timestamp or None
        timeout_seconds: configured timeout
        remaining_seconds: seconds left (0 if expired)
        locked: True if window has expired
    """
    timeout = _get_bootstrap_timeout()
    record = SiteSetting.query.filter_by(
        setting_key=BOOTSTRAP_WINDOW_STARTED_AT_KEY
    ).first()
    if not record or not record.setting_value:
        return {
            "started_at": None,
            "timeout_seconds": timeout,
            "remaining_seconds": 0,
            "locked": True,
        }

    try:
        started_at = datetime.fromisoformat(record.setting_value).replace(tzinfo=None)
    except (ValueError, TypeError):
        return {
            "started_at": None,
            "timeout_seconds": timeout,
            "remaining_seconds": 0,
            "locked": True,
        }

    elapsed = (utc_now() - started_at).total_seconds()
    remaining = max(0, timeout - elapsed)
    return {
        "started_at": record.setting_value,
        "timeout_seconds": timeout,
        "remaining_seconds": int(remaining),
        "locked": remaining <= 0,
    }


def is_bootstrap_locked() -> bool:
    """Return True if the bootstrap window has expired.

    When locked, the only way to unlock is to restart the container,
    which calls ``reset_bootstrap_window`` again.
    """
    if not is_bootstrap_required():
        return False
    return get_bootstrap_window_info()["locked"]


def clear_bootstrap_window() -> None:
    """Remove the bootstrap window timer after a successful bootstrap."""
    record = SiteSetting.query.filter_by(
        setting_key=BOOTSTRAP_WINDOW_STARTED_AT_KEY
    ).first()
    if record:
        db.session.delete(record)
        db.session.commit()


def apply_admin_recovery_if_requested() -> bool:
    """Apply explicit admin recovery mode from environment configuration."""
    if not current_app.config.get("ADMIN_FORCE_RESET", False):
        return False

    logger = get_logger(__name__)
    admins = User.query.filter(User.is_admin.is_(True)).all()
    if not admins:
        logger.warning(
            "Admin recovery requested but no admin users exist.",
            extra={"tracking_id": "SYSTEM"},
        )
        return False

    for user in admins:
        user.is_admin = False
        user.is_active = False
        user.must_change_password = False
        clear_session_token(user)

    db.session.commit()
    logger.warning(
        "Admin recovery mode demoted and disabled %s admin account(s).",
        len(admins),
        extra={"tracking_id": "SYSTEM"},
    )
    return True


def _generate_temporary_password() -> str:
    """Generate a random, policy-compliant, human-typeable temporary password."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
    body = "".join(secrets.choice(alphabet) for _ in range(12))
    # Guarantee at least one uppercase, one lowercase and one digit so the
    # generated value satisfies the "strong" and "unbreakable" policies too.
    return f"{body}Aa1"


def apply_admin_password_reset_if_requested() -> bool:
    """Reset every admin account's password in place from environment configuration.

    Unlike ``apply_admin_recovery_if_requested`` (``ADMIN_FORCE_RESET``), this does
    NOT demote or disable any admin account. It is meant as a non-destructive
    break-glass for a forgotten admin/gestor password: set ``ADMIN_RESET_PASSWORD=true``,
    restart the container, and a fresh temporary password is generated for each
    existing admin and printed to the logs (there is no email delivery in this
    self-hosted app). The account also has its login attempt lockout cleared and
    is forced to choose a new password on next login.
    """
    if not current_app.config.get("ADMIN_RESET_PASSWORD", False):
        return False

    logger = get_logger(__name__)
    admins = User.query.filter(User.is_admin.is_(True)).all()
    if not admins:
        logger.warning(
            "Admin password reset requested but no admin users exist.",
            extra={"tracking_id": "SYSTEM"},
        )
        return False

    for user in admins:
        temporary_password = _generate_temporary_password()
        user.set_password(temporary_password)
        user.must_change_password = True
        user.login_attempts = 0
        user.login_locked_until = None
        clear_session_token(user)
        logger.warning(
            "ADMIN_RESET_PASSWORD: temporary password for admin '%s' is: %s "
            "(you must change it on next login).",
            user.username,
            temporary_password,
            extra={"tracking_id": "SYSTEM"},
        )

    db.session.commit()
    logger.warning(
        "Admin password reset applied to %s admin account(s). Remove "
        "ADMIN_RESET_PASSWORD and restart once you have logged in.",
        len(admins),
        extra={"tracking_id": "SYSTEM"},
    )
    return True
