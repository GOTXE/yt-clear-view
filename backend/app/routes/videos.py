"""Video management routes."""

import random
from datetime import timedelta

from flask import Blueprint, g, jsonify, request
from sqlalchemy import or_

from app.config import Config
from app.extensions import db
from app.logging.logger import get_logger
from app.logging.tracking import generate_tracking_id
from app.middleware.auth_middleware import require_auth
from app.middleware.error_handler import handle_route_errors
from app.models import Channel, Theme, ThemeChannel, UserChannel, Video, VideoProgress, WatchedVideo
from app.utils.time import utc_now

videos_bp = Blueprint("videos", __name__)
logger = get_logger(__name__)


def _bad_request(message):
    """Return a JSON bad request response with tracking ID."""
    tracking_id = generate_tracking_id()
    logger.warning(message, extra={"tracking_id": tracking_id})
    return jsonify({"error": "Bad request.", "tracking_id": tracking_id, "status": 400}), 400


def _serialize_video(video, channel, watched, progress=None, continue_watching=None):
    """Serialize video with channel data, watched flag, and optional progress."""
    result = {
        "video": video.to_dict(),
        "channel": channel.to_dict() if channel else None,
        "watched": watched,
    }
    if progress is not None:
        result["progress"] = progress
    if continue_watching is not None:
        result["continue_watching"] = continue_watching
    return result


def _paginate_videos(query, user_id, limit, offset):
    """Return paginated videos with watched flags and progress."""
    items = query.offset(offset).limit(limit + 1).all()
    has_more = len(items) > limit
    videos = items[:limit]

    video_ids = [video.id for video in videos]
    watched_ids = set()
    progress_map = {}
    if video_ids:
        watched_entries = (
            WatchedVideo.query.filter_by(user_id=user_id)
            .filter(WatchedVideo.video_id.in_(video_ids))
            .all()
        )
        watched_ids = {entry.video_id for entry in watched_entries}

        progress_entries = (
            VideoProgress.query.filter_by(user_id=user_id)
            .filter(VideoProgress.video_id.in_(video_ids))
            .all()
        )
        progress_map = {
            p.video_id: {
                "position": p.position_seconds,
                "continue_watching": p.is_continue_watching,
            }
            for p in progress_entries
        }

    payload = []
    for video in videos:
        progress_entry = progress_map.get(video.id) or {}
        payload.append(_serialize_video(
            video, video.channel, video.id in watched_ids,
            progress=progress_entry.get("position"),
            continue_watching=progress_entry.get("continue_watching"),
        ))

    next_offset = offset + limit if has_more else None
    return payload, has_more, next_offset


def _paginate_videos_random(query, user_id, limit, offset, seed):
    """Return randomized videos with watched flags and progress, stable per seed."""
    items = query.all()
    rng = random.Random(seed)
    rng.shuffle(items)
    has_more = len(items) > offset + limit
    videos = items[offset:offset + limit]

    video_ids = [video.id for video in videos]
    watched_ids = set()
    progress_map = {}
    if video_ids:
        watched_entries = (
            WatchedVideo.query.filter_by(user_id=user_id)
            .filter(WatchedVideo.video_id.in_(video_ids))
            .all()
        )
        watched_ids = {entry.video_id for entry in watched_entries}

        progress_entries = (
            VideoProgress.query.filter_by(user_id=user_id)
            .filter(VideoProgress.video_id.in_(video_ids))
            .all()
        )
        progress_map = {
            p.video_id: {
                "position": p.position_seconds,
                "continue_watching": p.is_continue_watching,
            }
            for p in progress_entries
        }

    payload = []
    for video in videos:
        progress_entry = progress_map.get(video.id) or {}
        payload.append(_serialize_video(
            video, video.channel, video.id in watched_ids,
            progress=progress_entry.get("position"),
            continue_watching=progress_entry.get("continue_watching"),
        ))

    next_offset = offset + limit if has_more else None
    return payload, has_more, next_offset


def _parse_days(value, field_name):
    """Parse days query params into positive integers."""
    if value is None:
        return None
    try:
        days = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"Invalid {field_name}.")
    if days <= 0:
        raise ValueError(f"Invalid {field_name}.")
    return days


def _parse_bool(value):
    """Parse boolean query params."""
    if value is None:
        return False
    return str(value).lower() in ("true", "1", "yes", "y")


def _apply_video_filters(query, user_id, content_type, since_days, older_than_days, only_unwatched):
    """Apply content type, age, and watched filters to the video query."""
    if content_type == "short":
        query = query.filter(Video.duration <= Config.SHORTS_MAX_DURATION_SECONDS)
    elif content_type == "video":
        query = query.filter(or_(Video.duration.is_(None), Video.duration > Config.SHORTS_MAX_DURATION_SECONDS))

    if since_days:
        cutoff = utc_now() - timedelta(days=since_days)
        query = query.filter(Video.published_at.isnot(None), Video.published_at >= cutoff)

    if older_than_days:
        cutoff = utc_now() - timedelta(days=older_than_days)
        query = query.filter(Video.published_at.isnot(None), Video.published_at < cutoff)

    if only_unwatched:
        watched_subquery = (
            WatchedVideo.query.with_entities(WatchedVideo.video_id)
            .filter_by(user_id=user_id)
        )
        query = query.filter(~Video.id.in_(watched_subquery))

    return query


@videos_bp.get("/api/videos/latest")
@handle_route_errors
@require_auth
def latest_videos():
    """Return latest videos from all subscribed channels."""
    user = g.current_user
    try:
        limit = int(request.args.get("limit", 50))
        offset = int(request.args.get("offset", 0))
    except ValueError:
        return _bad_request("Invalid pagination values.")

    if limit <= 0 or offset < 0:
        return _bad_request("Invalid pagination values.")

    channel_id = request.args.get("channel_id")
    yt_channel_id = (request.args.get("yt_channel_id") or "").strip() or None
    if channel_id is not None:
        try:
            channel_id = int(channel_id)
        except (TypeError, ValueError):
            return _bad_request("Invalid channel_id.")
        if channel_id <= 0:
            return _bad_request("Invalid channel_id.")
    if yt_channel_id:
        channel = Channel.query.filter_by(yt_channel_id=yt_channel_id).first()
        if not channel:
            return jsonify({"videos": [], "has_more": False, "next_offset": None})
        if channel_id is not None and channel.id != channel_id:
            return _bad_request("Mismatched channel_id.")
        channel_id = channel.id

    content_type = request.args.get("content_type")
    if content_type and content_type not in ("video", "short"):
        return _bad_request("Invalid content_type.")

    try:
        since_days = _parse_days(request.args.get("since_days"), "since_days")
        older_than_days = _parse_days(request.args.get("older_than_days"), "older_than_days")
    except ValueError as error:
        return _bad_request(str(error))

    only_unwatched = _parse_bool(request.args.get("only_unwatched"))
    randomize = _parse_bool(request.args.get("randomize"))

    channel_ids = [
        sub.channel_id for sub in UserChannel.query.filter_by(user_id=user.id).all()
    ]
    if not channel_ids:
        return jsonify({"videos": [], "has_more": False, "next_offset": None})

    if channel_id is not None and channel_id not in channel_ids:
        return jsonify({"videos": [], "has_more": False, "next_offset": None})

    query = Video.query.filter(Video.channel_id.in_(channel_ids)).order_by(
        Video.published_at.desc()
    )
    if channel_id is not None:
        query = query.filter(Video.channel_id == channel_id)
    query = _apply_video_filters(
        query,
        user.id,
        content_type,
        since_days,
        older_than_days,
        only_unwatched,
    )
    if randomize:
        seed = int(utc_now().strftime("%Y%j"))
        payload, has_more, next_offset = _paginate_videos_random(
            query, user.id, limit, offset, seed
        )
    else:
        payload, has_more, next_offset = _paginate_videos(query, user.id, limit, offset)
    return jsonify({"videos": payload, "has_more": has_more, "next_offset": next_offset})


@videos_bp.get("/api/videos/by-theme/<int:theme_id>")
@handle_route_errors
@require_auth
def videos_by_theme(theme_id):
    """Return videos for channels associated with a theme."""
    user = g.current_user
    try:
        limit = int(request.args.get("limit", 50))
        offset = int(request.args.get("offset", 0))
    except ValueError:
        return _bad_request("Invalid pagination values.")

    if limit <= 0 or offset < 0:
        return _bad_request("Invalid pagination values.")

    content_type = request.args.get("content_type")
    if content_type and content_type not in ("video", "short"):
        return _bad_request("Invalid content_type.")

    try:
        since_days = _parse_days(request.args.get("since_days"), "since_days")
        older_than_days = _parse_days(request.args.get("older_than_days"), "older_than_days")
    except ValueError as error:
        return _bad_request(str(error))

    only_unwatched = _parse_bool(request.args.get("only_unwatched"))

    theme = Theme.query.filter_by(id=theme_id, user_id=user.id).first()
    if not theme:
        tracking_id = generate_tracking_id()
        logger.warning("Theme not found.", extra={"tracking_id": tracking_id})
        return (
            jsonify({"error": "Not found.", "tracking_id": tracking_id, "status": 404}),
            404,
        )

    channel_ids = [link.channel_id for link in ThemeChannel.query.filter_by(theme_id=theme_id).all()]
    if not channel_ids:
        return jsonify({"videos": [], "has_more": False, "next_offset": None})

    query = Video.query.filter(Video.channel_id.in_(channel_ids)).order_by(
        Video.published_at.desc()
    )
    query = _apply_video_filters(
        query,
        user.id,
        content_type,
        since_days,
        older_than_days,
        only_unwatched,
    )
    payload, has_more, next_offset = _paginate_videos(query, user.id, limit, offset)
    return jsonify({"videos": payload, "has_more": has_more, "next_offset": next_offset})


@videos_bp.get("/api/videos/summary")
@handle_route_errors
@require_auth
def video_summary():
    """Return counts of unwatched videos and shorts in the last N days."""
    user = g.current_user
    try:
        days = _parse_days(request.args.get("days", 7), "days")
    except ValueError as error:
        return _bad_request(str(error))

    channel_id = request.args.get("channel_id")
    yt_channel_id = (request.args.get("yt_channel_id") or "").strip() or None
    if channel_id is not None:
        try:
            channel_id = int(channel_id)
        except (TypeError, ValueError):
            return _bad_request("Invalid channel_id.")
        if channel_id <= 0:
            return _bad_request("Invalid channel_id.")
    if yt_channel_id:
        channel = Channel.query.filter_by(yt_channel_id=yt_channel_id).first()
        if not channel:
            return jsonify({"videos": 0, "shorts": 0, "days": days})
        if channel_id is not None and channel.id != channel_id:
            return _bad_request("Mismatched channel_id.")
        channel_id = channel.id

    channel_ids = [
        sub.channel_id for sub in UserChannel.query.filter_by(user_id=user.id).all()
    ]
    if not channel_ids:
        return jsonify({"videos": 0, "shorts": 0, "days": days})

    if channel_id is not None and channel_id not in channel_ids:
        return jsonify({"videos": 0, "shorts": 0, "days": days})

    base_query = Video.query.filter(Video.channel_id.in_(channel_ids))
    if channel_id is not None:
        base_query = base_query.filter(Video.channel_id == channel_id)
    base_query = _apply_video_filters(
        base_query,
        user.id,
        None,
        since_days=days,
        older_than_days=None,
        only_unwatched=True,
    )

    videos_count = base_query.filter(or_(Video.duration.is_(None), Video.duration > Config.SHORTS_MAX_DURATION_SECONDS)).count()
    shorts_count = base_query.filter(Video.duration <= Config.SHORTS_MAX_DURATION_SECONDS).count()
    return jsonify({"videos": videos_count, "shorts": shorts_count, "days": days})


@videos_bp.post("/api/videos/<int:video_id>/watch")
@handle_route_errors
@require_auth
def mark_watched(video_id):
    """Mark a video as watched for the current user."""
    user = g.current_user
    payload = request.get_json(silent=True) or {}
    device_id = payload.get("device_id")

    video = db.session.get(Video, video_id)
    if not video:
        tracking_id = generate_tracking_id()
        logger.warning("Video not found.", extra={"tracking_id": tracking_id})
        return (
            jsonify({"error": "Not found.", "tracking_id": tracking_id, "status": 404}),
            404,
        )

    watched = WatchedVideo.query.filter_by(user_id=user.id, video_id=video.id).first()
    if not watched:
        watched = WatchedVideo(user_id=user.id, video_id=video.id, device_id=device_id)
        db.session.add(watched)

    # Clear any saved playback progress
    VideoProgress.query.filter_by(user_id=user.id, video_id=video.id).delete()
    db.session.commit()

    return "", 204


@videos_bp.delete("/api/videos/<int:video_id>/unwatch")
@handle_route_errors
@require_auth
def unwatch_video(video_id):
    """Remove watched status for a video and user."""
    user = g.current_user
    watched = WatchedVideo.query.filter_by(user_id=user.id, video_id=video_id).first()
    if watched:
        db.session.delete(watched)
        db.session.commit()
    return "", 204


@videos_bp.put("/api/videos/<int:video_id>/progress")
@handle_route_errors
@require_auth
def save_progress(video_id):
    """Save playback position for resume functionality."""
    user = g.current_user
    payload = request.get_json(silent=True) or {}

    position = payload.get("position_seconds")
    if position is None or not isinstance(position, (int, float)) or position < 0:
        return _bad_request("position_seconds is required and must be >= 0.")

    duration = payload.get("duration_seconds")
    if duration is not None and (not isinstance(duration, (int, float)) or duration <= 0):
        duration = None
    continue_watching = payload.get("continue_watching")
    if continue_watching is not None and not isinstance(continue_watching, bool):
        return _bad_request("continue_watching must be boolean when provided.")

    video = db.session.get(Video, video_id)
    if not video:
        tracking_id = generate_tracking_id()
        logger.warning("Video not found.", extra={"tracking_id": tracking_id})
        return (
            jsonify({"error": "Not found.", "tracking_id": tracking_id, "status": 404}),
            404,
        )

    progress = VideoProgress.query.filter_by(user_id=user.id, video_id=video.id).first()
    if progress:
        progress.position_seconds = int(position)
        progress.duration_seconds = int(duration) if duration else progress.duration_seconds
        if continue_watching is not None:
            progress.is_continue_watching = continue_watching
        progress.updated_at = utc_now()
    else:
        progress = VideoProgress(
            user_id=user.id,
            video_id=video.id,
            position_seconds=int(position),
            duration_seconds=int(duration) if duration else None,
            is_continue_watching=bool(continue_watching),
        )
        db.session.add(progress)

    db.session.commit()
    return "", 204


@videos_bp.delete("/api/videos/<int:video_id>/progress")
@handle_route_errors
@require_auth
def clear_progress(video_id):
    """Clear saved playback position for a video."""
    user = g.current_user
    VideoProgress.query.filter_by(user_id=user.id, video_id=video_id).delete()
    db.session.commit()
    return "", 204


@videos_bp.get("/api/videos/in-progress")
@handle_route_errors
@require_auth
def list_in_progress():
    """Return videos with saved playback progress, most recently updated first."""
    user = g.current_user
    limit = min(int(request.args.get("limit", 20)), 100)
    offset = int(request.args.get("offset", 0))

    progress_query = (
        VideoProgress.query
        .filter_by(user_id=user.id)
        .filter(VideoProgress.is_continue_watching.is_(True))
        .order_by(VideoProgress.updated_at.desc())
        .offset(offset)
        .limit(limit + 1)
        .all()
    )

    has_more = len(progress_query) > limit
    entries = progress_query[:limit]

    if not entries:
        return jsonify({"videos": [], "has_more": False, "next_offset": None})

    video_ids = [e.video_id for e in entries]
    videos_map = {v.id: v for v in Video.query.filter(Video.id.in_(video_ids)).all()}

    watched_entries = (
        WatchedVideo.query.filter_by(user_id=user.id)
        .filter(WatchedVideo.video_id.in_(video_ids))
        .all()
    )
    watched_ids = {e.video_id for e in watched_entries}

    payload = []
    for entry in entries:
        video = videos_map.get(entry.video_id)
        if not video:
            continue
        payload.append(_serialize_video(
            video, video.channel, video.id in watched_ids,
            progress=entry.position_seconds,
            continue_watching=entry.is_continue_watching,
        ))

    next_offset = offset + limit if has_more else None
    return jsonify({"videos": payload, "has_more": has_more, "next_offset": next_offset})


@videos_bp.get("/api/videos/watched")
@handle_route_errors
@require_auth
def list_watched_videos():
    """Return watched videos for the current user, most recently watched first."""
    user = g.current_user
    try:
        limit = int(request.args.get("limit", 20))
        offset = int(request.args.get("offset", 0))
    except ValueError:
        return _bad_request("Invalid pagination values.")

    if limit <= 0 or offset < 0:
        return _bad_request("Invalid pagination values.")

    channel_id = request.args.get("channel_id")
    yt_channel_id = (request.args.get("yt_channel_id") or "").strip() or None
    if channel_id is not None:
        try:
            channel_id = int(channel_id)
        except (TypeError, ValueError):
            return _bad_request("Invalid channel_id.")
        if channel_id <= 0:
            return _bad_request("Invalid channel_id.")
    if yt_channel_id:
        channel = Channel.query.filter_by(yt_channel_id=yt_channel_id).first()
        if not channel:
            return jsonify({"videos": [], "has_more": False, "next_offset": None})
        if channel_id is not None and channel.id != channel_id:
            return _bad_request("Mismatched channel_id.")
        channel_id = channel.id

    content_type = request.args.get("content_type")
    if content_type and content_type not in ("video", "short"):
        return _bad_request("Invalid content_type.")

    subscribed_ids = [
        sub.channel_id for sub in UserChannel.query.filter_by(user_id=user.id).all()
    ]
    if not subscribed_ids:
        return jsonify({"videos": [], "has_more": False, "next_offset": None})

    if channel_id is not None and channel_id not in subscribed_ids:
        return jsonify({"videos": [], "has_more": False, "next_offset": None})

    query = (
        WatchedVideo.query
        .filter_by(user_id=user.id)
        .join(Video, WatchedVideo.video_id == Video.id)
        .filter(Video.channel_id.in_(subscribed_ids))
    )
    if channel_id is not None:
        query = query.filter(Video.channel_id == channel_id)
    if content_type == "short":
        query = query.filter(Video.duration <= Config.SHORTS_MAX_DURATION_SECONDS)
    elif content_type == "video":
        query = query.filter(or_(Video.duration.is_(None), Video.duration > Config.SHORTS_MAX_DURATION_SECONDS))

    watched_query = (
        query.order_by(WatchedVideo.watched_at.desc())
        .offset(offset)
        .limit(limit + 1)
        .all()
    )

    has_more = len(watched_query) > limit
    entries = watched_query[:limit]
    if not entries:
        return jsonify({"videos": [], "has_more": False, "next_offset": None})

    video_ids = [entry.video_id for entry in entries]
    videos_map = {video.id: video for video in Video.query.filter(Video.id.in_(video_ids)).all()}
    progress_entries = (
        VideoProgress.query.filter_by(user_id=user.id)
        .filter(VideoProgress.video_id.in_(video_ids))
        .all()
    )
    progress_map = {
        entry.video_id: {
            "position": entry.position_seconds,
            "continue_watching": entry.is_continue_watching,
        }
        for entry in progress_entries
    }

    payload = []
    for entry in entries:
        video = videos_map.get(entry.video_id)
        if not video:
            continue
        progress_entry = progress_map.get(video.id) or {}
        payload.append(_serialize_video(
            video,
            video.channel,
            True,
            progress=progress_entry.get("position"),
            continue_watching=progress_entry.get("continue_watching"),
        ))

    next_offset = offset + limit if has_more else None
    return jsonify({"videos": payload, "has_more": has_more, "next_offset": next_offset})


@videos_bp.get("/api/videos/search")
@handle_route_errors
@require_auth
def search_videos():
    """Search videos in the local database with optional filters."""
    user = g.current_user
    query_text = (request.args.get("q") or "").strip()
    if not query_text:
        return _bad_request("Missing query text.")

    try:
        limit = int(request.args.get("limit", 20))
        offset = int(request.args.get("offset", 0))
    except ValueError:
        return _bad_request("Invalid pagination values.")

    if limit <= 0 or offset < 0:
        return _bad_request("Invalid pagination values.")

    channel_id = request.args.get("channel_id")
    yt_channel_id = (request.args.get("yt_channel_id") or "").strip() or None
    theme_id = request.args.get("theme_id")

    subscribed_ids = [
        sub.channel_id for sub in UserChannel.query.filter_by(user_id=user.id).all()
    ]
    if not subscribed_ids:
        return jsonify({"videos": [], "has_more": False, "next_offset": None})

    query = Video.query.filter(Video.channel_id.in_(subscribed_ids))

    if channel_id:
        try:
            channel_id = int(channel_id)
        except ValueError:
            return _bad_request("Invalid channel_id.")
        if channel_id not in subscribed_ids:
            return jsonify({"videos": [], "has_more": False, "next_offset": None})
        query = query.filter(Video.channel_id == channel_id)
    if yt_channel_id:
        channel = Channel.query.filter_by(yt_channel_id=yt_channel_id).first()
        if not channel:
            return jsonify({"videos": [], "has_more": False, "next_offset": None})
        if channel.id not in subscribed_ids:
            return jsonify({"videos": [], "has_more": False, "next_offset": None})
        query = query.filter(Video.channel_id == channel.id)

    if theme_id:
        try:
            theme_id = int(theme_id)
        except ValueError:
            return _bad_request("Invalid theme_id.")
        theme = Theme.query.filter_by(id=theme_id, user_id=user.id).first()
        if not theme:
            tracking_id = generate_tracking_id()
            logger.warning("Theme not found.", extra={"tracking_id": tracking_id})
            return (
                jsonify({"error": "Not found.", "tracking_id": tracking_id, "status": 404}),
                404,
            )
        theme_channel_ids = [
            link.channel_id for link in ThemeChannel.query.filter_by(theme_id=theme_id).all()
        ]
        if theme_channel_ids:
            query = query.filter(Video.channel_id.in_(theme_channel_ids))
        else:
            return jsonify({"videos": [], "has_more": False, "next_offset": None})

    query = query.filter(
        or_(
            Video.title.ilike(f"%{query_text}%"),
            Video.description.ilike(f"%{query_text}%"),
        )
    ).order_by(Video.published_at.desc())

    payload, has_more, next_offset = _paginate_videos(query, user.id, limit, offset)
    return jsonify({"videos": payload, "has_more": has_more, "next_offset": next_offset})
