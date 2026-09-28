"""Tests for the non-destructive ADMIN_RESET_PASSWORD mechanism."""

from app.extensions import db
from app.models import User
from app.services.admin_bootstrap import apply_admin_password_reset_if_requested


def _create_admin(app, username="admin", locked=False):
    with app.app_context():
        user = User(username=username, display_name="Admin", is_admin=True, is_active=True)
        user.set_password("OriginalPass123")
        if locked:
            from datetime import timedelta

            from app.utils.time import utc_now

            user.login_attempts = 5
            user.login_locked_until = utc_now() + timedelta(minutes=15)
        db.session.add(user)
        db.session.commit()
        return user.id


def test_noop_when_flag_disabled(app):
    _create_admin(app)
    with app.app_context():
        app.config["ADMIN_RESET_PASSWORD"] = False
        assert apply_admin_password_reset_if_requested() is False


def test_noop_when_no_admin_exists(app):
    with app.app_context():
        app.config["ADMIN_RESET_PASSWORD"] = True
        assert apply_admin_password_reset_if_requested() is False


def test_resets_password_and_clears_lockout(app):
    user_id = _create_admin(app, locked=True)
    with app.app_context():
        app.config["ADMIN_RESET_PASSWORD"] = True
        original_hash = User.query.get(user_id).password_hash

        assert apply_admin_password_reset_if_requested() is True

        user = User.query.get(user_id)
        assert user.password_hash != original_hash
        assert user.must_change_password is True
        assert user.login_attempts == 0
        assert user.login_locked_until is None
        # Admin/active status must be untouched, unlike ADMIN_FORCE_RESET.
        assert user.is_admin is True
        assert user.is_active is True


def test_does_not_touch_non_admin_users(app):
    _create_admin(app)
    with app.app_context():
        regular = User(username="viewer", display_name="Viewer", is_admin=False, is_active=True)
        regular.set_password("ViewerPass123")
        db.session.add(regular)
        db.session.commit()
        regular_id = regular.id
        regular_hash = regular.password_hash

        app.config["ADMIN_RESET_PASSWORD"] = True
        apply_admin_password_reset_if_requested()

        assert User.query.get(regular_id).password_hash == regular_hash
