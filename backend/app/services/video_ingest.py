"""Video ingestion and refresh logic with caps."""

from datetime import datetime, timedelta

from sqlalchemy import or_

from app.config import Config
from app.extensions import db
from app.logging.logger import get_logger
from app.logging.tracking import generate_tracking_id
from app.models import ChannelCategory, UserChannel, Video
from app.services.classification_service import ClassificationService
from app.services.presets import get_preset
from app.services.rss_feed import fetch_channel_feed
from app.services.quota import consume, mark_quota_exhausted, reset_quota_if_needed
from app.services.site_settings import get_video_refresh_mode
from app.utils.time import utc_now

logger = get_logger(__name__)


def _parse_datetime(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def _is_short(duration):
    if duration is None:
        return False
    try:
        return int(duration) <= Config.SHORTS_MAX_DURATION_SECONDS
    except (TypeError, ValueError):
        return False


def _serialize_tags(value):
    if not value:
        return None
    if isinstance(value, list):
        cleaned = [str(tag).strip() for tag in value if str(tag).strip()]
        return " ".join(cleaned) if cleaned else None
    text = str(value).strip()
    return text or None


def _update_video_from_item(video, item, published_at):
    updated = False
    serialized_tags = _serialize_tags(item.get("tags"))

    if item.get("title") and item.get("title") != video.title:
        video.title = item.get("title")
        updated = True
    if item.get("description") and item.get("description") != video.description:
        video.description = item.get("description")
        updated = True
    if item.get("thumbnail") and item.get("thumbnail") != video.thumbnail_url:
        video.thumbnail_url = item.get("thumbnail")
        updated = True
    if published_at and published_at != video.published_at:
        video.published_at = published_at
        updated = True
    if item.get("duration") is not None and item.get("duration") != video.duration:
        video.duration = item.get("duration")
        updated = True
    if item.get("video_category_id") and item.get("video_category_id") != video.video_category_id:
        video.video_category_id = item.get("video_category_id")
        updated = True
    if serialized_tags and serialized_tags != video.tags:
        video.tags = serialized_tags
        updated = True
    if item.get("discovered_via") and item.get("discovered_via") != video.discovered_via:
        video.discovered_via = item.get("discovered_via")
        updated = True
    if item.get("metadata_incomplete") is not None and item.get("metadata_incomplete") != video.metadata_incomplete:
        video.metadata_incomplete = item.get("metadata_incomplete")
        updated = True
    if item.get("source_last_seen_at") and item.get("source_last_seen_at") != video.source_last_seen_at:
        video.source_last_seen_at = item.get("source_last_seen_at")
        updated = True
    if item.get("feed_published_at") and item.get("feed_published_at") != video.feed_published_at:
        video.feed_published_at = item.get("feed_published_at")
        updated = True
    if item.get("feed_updated_at") and item.get("feed_updated_at") != video.feed_updated_at:
        video.feed_updated_at = item.get("feed_updated_at")
        updated = True

    return updated


def _build_rss_item(entry, now):
    published_at = _parse_datetime(entry.published_at)
    updated_at = _parse_datetime(entry.updated_at)
    return {
        "video_id": entry.video_id,
        "title": entry.title,
        "description": None,
        "video_category_id": None,
        "tags": [],
        "thumbnail": getattr(entry, "thumbnail", None),
        "published_at": entry.published_at,
        "duration": None,
        "discovered_via": "rss",
        "metadata_incomplete": True,
        "source_last_seen_at": now,
        "feed_published_at": published_at,
        "feed_updated_at": updated_at,
    }


def _apply_completion_items(channel, completion_items, now):
    updates = 0
    for item in completion_items:
        video_id = item.get("video_id")
        if not video_id:
            continue
        video = Video.query.filter_by(yt_video_id=video_id, channel_id=channel.id).first()
        if not video:
            continue
        published_at = _parse_datetime(item.get("published_at"))
        enriched_item = dict(item)
        enriched_item["discovered_via"] = "rss"
        enriched_item["metadata_incomplete"] = False
        enriched_item["source_last_seen_at"] = now
        enriched_item["feed_published_at"] = video.feed_published_at or published_at
        enriched_item["feed_updated_at"] = video.feed_updated_at
        if _update_video_from_item(video, enriched_item, published_at):
            updates += 1
    return updates


def _log_channel_refresh_path(
    channel,
    refresh_mode,
    path,
    channel_new_videos=0,
    channel_metadata_updates=0,
    success=True,
):
    logger.info(
        "Channel refresh path resolved. mode=%s path=%s channel_title=%s yt_channel_id=%s new_videos=%s metadata_updates=%s success=%s",
        refresh_mode,
        path,
        channel.title or "-",
        channel.yt_channel_id,
        channel_new_videos,
        channel_metadata_updates,
        success,
        extra={"tracking_id": generate_tracking_id(), "channel_id": channel.id},
    )


def _ingest_api_items(
    channel,
    subscription,
    response,
    preset,
    recent_cutoff,
    older_min_cutoff,
    older_max_cutoff,
    ignore_last_refreshed,
):
    latest_seen = subscription.last_refreshed_at
    recent_video_count = _range_counts(channel.id, recent_cutoff, None, False)
    recent_short_count = _range_counts(channel.id, recent_cutoff, None, True)
    older_video_count = _range_counts(channel.id, older_max_cutoff, older_min_cutoff, False)
    older_short_count = _range_counts(channel.id, older_max_cutoff, older_min_cutoff, True)
    channel_new_videos = 0
    channel_metadata_updates = 0
    completion_candidates = set()

    for item in response.get("videos", []):
        video_id = item.get("video_id")
        if not video_id:
            continue

        published_at = _parse_datetime(item.get("published_at"))
        if not published_at:
            continue

        if published_at < older_max_cutoff:
            continue

        exists = Video.query.filter_by(yt_video_id=video_id).first()
        if exists:
            if _update_video_from_item(exists, item, published_at):
                channel_metadata_updates += 1
            if exists.metadata_incomplete:
                completion_candidates.add(video_id)
            continue

        if not ignore_last_refreshed and subscription.last_refreshed_at:
            if published_at <= subscription.last_refreshed_at:
                continue

        is_short = _is_short(item.get("duration"))

        if published_at >= recent_cutoff:
            if is_short:
                if recent_short_count >= preset["recent_short_cap"]:
                    continue
                recent_short_count += 1
            else:
                if recent_video_count >= preset["recent_video_cap"]:
                    continue
                recent_video_count += 1
        elif published_at < older_min_cutoff and published_at >= older_max_cutoff:
            if is_short:
                if older_short_count >= preset["older_short_cap"]:
                    continue
                older_short_count += 1
            else:
                if older_video_count >= preset["older_video_cap"]:
                    continue
                older_video_count += 1
        else:
            continue

        video = Video(
            yt_video_id=video_id,
            channel_id=channel.id,
            title=item.get("title"),
            description=item.get("description"),
            video_category_id=item.get("video_category_id"),
            tags=_serialize_tags(item.get("tags")),
            thumbnail_url=item.get("thumbnail"),
            published_at=published_at,
            duration=item.get("duration"),
            discovered_via=item.get("discovered_via") or "api",
            metadata_incomplete=bool(item.get("metadata_incomplete")),
            source_last_seen_at=item.get("source_last_seen_at"),
            feed_published_at=item.get("feed_published_at"),
            feed_updated_at=item.get("feed_updated_at"),
        )
        db.session.add(video)
        channel_new_videos += 1
        if video.metadata_incomplete:
            completion_candidates.add(video_id)

        if latest_seen is None or published_at > latest_seen:
            latest_seen = published_at

    return {
        "channel_new_videos": channel_new_videos,
        "channel_metadata_updates": channel_metadata_updates,
        "latest_seen": latest_seen,
        "completion_candidates": list(completion_candidates),
    }


def _refresh_channel_via_rss(
    channel,
    subscription,
    service,
    settings,
    preset,
    recent_cutoff,
    older_min_cutoff,
    older_max_cutoff,
    ignore_last_refreshed,
    now,
):
    used_api_completion = False
    feed_response = fetch_channel_feed(channel.yt_channel_id)
    subscription.last_feed_checked_at = now
    if not feed_response.get("success"):
        subscription.last_feed_error_at = now
        subscription.feed_error_count = int(subscription.feed_error_count or 0) + 1
        return {
            "success": False,
            "rate_limited": False,
            "fallback_to_api": True,
            "used_rss": False,
            "used_api_completion": False,
        }

    subscription.last_feed_success_at = now
    subscription.feed_error_count = 0

    rss_items = [_build_rss_item(entry, now) for entry in feed_response.get("entries", [])]
    ingest_result = _ingest_api_items(
        channel,
        subscription,
        {"videos": rss_items},
        preset,
        recent_cutoff,
        older_min_cutoff,
        older_max_cutoff,
        ignore_last_refreshed,
    )

    completion_ids = ingest_result.get("completion_candidates", [])

    if completion_ids:
        if not consume(settings, Config.YT_RSS_COMPLETION_COST):
            return {
                "success": True,
                "rate_limited": False,
                "channel_new_videos": ingest_result["channel_new_videos"],
                "channel_metadata_updates": ingest_result["channel_metadata_updates"],
                "latest_seen": ingest_result["latest_seen"],
            }

        completion_response = service.get_videos_by_ids(completion_ids, quota_session=db.session)
        if completion_response.get("rate_limited"):
            mark_quota_exhausted(settings)
            return {
                "success": False,
                "rate_limited": True,
                "used_rss": True,
                "used_api_completion": False,
            }
        if completion_response.get("success"):
            used_api_completion = True
            logger.info(
                "RSS-discovered videos queued targeted API completion.",
                extra={
                    "tracking_id": generate_tracking_id(),
                    "channel_id": channel.id,
                    "video_count": len(completion_ids),
                },
            )
            ingest_result["channel_metadata_updates"] += _apply_completion_items(
                channel,
                completion_response.get("videos", []),
                now,
            )

    return {
        "success": True,
        "rate_limited": False,
        "channel_new_videos": ingest_result["channel_new_videos"],
        "channel_metadata_updates": ingest_result["channel_metadata_updates"],
        "latest_seen": ingest_result["latest_seen"],
        "used_rss": True,
        "used_api_completion": used_api_completion,
    }


def _resolve_refresh_mode(subscription):
    override = (subscription.refresh_mode_override or "").strip().lower()
    if override in {"hybrid", "rss_preferred", "api_only"}:
        return override
    return get_video_refresh_mode(Config.VIDEO_REFRESH_MODE)


def upsert_channel_video_evidence(channel, items):
    """Upsert local video evidence for a channel from YT API items."""
    created = 0
    updated = 0

    for item in items:
        video_id = item.get("video_id")
        if not video_id:
            continue

        published_at = _parse_datetime(item.get("published_at"))
        exists = Video.query.filter_by(yt_video_id=video_id).first()
        if exists:
            if _update_video_from_item(exists, item, published_at):
                updated += 1
            continue

        video = Video(
            yt_video_id=video_id,
            channel_id=channel.id,
            title=item.get("title"),
            description=item.get("description"),
            video_category_id=item.get("video_category_id"),
            tags=_serialize_tags(item.get("tags")),
            thumbnail_url=item.get("thumbnail"),
            published_at=published_at,
            duration=item.get("duration"),
        )
        db.session.add(video)
        created += 1

    return created, updated


def _range_counts(channel_id, start, end, is_short):
    query = Video.query.filter(Video.channel_id == channel_id)
    if start:
        query = query.filter(Video.published_at.isnot(None), Video.published_at >= start)
    if end:
        query = query.filter(Video.published_at.isnot(None), Video.published_at < end)
    if is_short:
        query = query.filter(Video.duration <= Config.SHORTS_MAX_DURATION_SECONDS)
    else:
        query = query.filter(or_(Video.duration.is_(None), Video.duration > Config.SHORTS_MAX_DURATION_SECONDS))
    return query.count()


def _prune_range(channel_id, start, end, is_short, cap):
    if cap <= 0:
        return
    query = Video.query.filter(Video.channel_id == channel_id)
    if start:
        query = query.filter(Video.published_at.isnot(None), Video.published_at >= start)
    if end:
        query = query.filter(Video.published_at.isnot(None), Video.published_at < end)
    if is_short:
        query = query.filter(Video.duration <= Config.SHORTS_MAX_DURATION_SECONDS)
    else:
        query = query.filter(or_(Video.duration.is_(None), Video.duration > Config.SHORTS_MAX_DURATION_SECONDS))

    items = query.order_by(Video.published_at.desc()).all()
    for video in items[cap:]:
        db.session.delete(video)


def _delete_older_than(channel_id, cutoff):
    if not cutoff:
        return
    old_items = (
        Video.query.filter(Video.channel_id == channel_id, Video.published_at.isnot(None))
        .filter(Video.published_at < cutoff)
        .all()
    )
    for video in old_items:
        db.session.delete(video)


def iter_refresh_user_channels(
    user,
    settings,
    service,
    channel_id=None,
    ignore_last_refreshed=False,
    now=None,
):
    """Yield incremental refresh progress for a user with per-channel caps."""
    now = now or utc_now()
    preset = get_preset(settings.preset)
    recent_days = preset["recent_days"]
    older_min_days = preset["older_min_days"]
    older_max_days = preset["older_max_days"]

    recent_cutoff = now - timedelta(days=recent_days)
    older_min_cutoff = now - timedelta(days=older_min_days)
    older_max_cutoff = now - timedelta(days=older_max_days)

    if channel_id:
        subscriptions = UserChannel.query.filter_by(user_id=user.id, channel_id=channel_id).all()
    else:
        subscriptions = UserChannel.query.filter_by(user_id=user.id).all()

    total_channels = len(subscriptions)
    if not subscriptions:
        yield {
            "type": "complete",
            "new_videos": 0,
            "rate_limited": False,
            "processed_channels": 0,
            "total_channels": 0,
        }
        return

    new_videos = 0
    rate_limited = False
    processed_channels = 0
    classifier = None

    reset_quota_if_needed(settings)

    yield {
        "type": "start",
        "new_videos": 0,
        "rate_limited": False,
        "processed_channels": 0,
        "total_channels": total_channels,
    }

    for index, subscription in enumerate(subscriptions, start=1):
        channel = subscription.channel
        channel_new_videos = 0
        channel_metadata_updates = 0
        refresh_mode = _resolve_refresh_mode(subscription)
        refresh_path = "api_only" if refresh_mode == "api_only" else "rss"

        yield {
            "type": "channel_started",
            "channel_id": channel.id,
            "yt_channel_id": channel.yt_channel_id,
            "channel_title": channel.title,
            "processed_channels": processed_channels,
            "current_channel": index,
            "total_channels": total_channels,
            "new_videos": new_videos,
        }

        refresh_result = {"fallback_to_api": True}
        if refresh_mode != "api_only":
            refresh_result = _refresh_channel_via_rss(
                channel,
                subscription,
                service,
                settings,
                preset,
                recent_cutoff,
                older_min_cutoff,
                older_max_cutoff,
                ignore_last_refreshed,
                now,
            )
            if refresh_result.get("fallback_to_api") and refresh_mode == "rss_preferred":
                refresh_path = "rss_failed_no_api_fallback"
                logger.info(
                    "Channel refresh skipped API fallback because rss_preferred mode is active.",
                    extra={"tracking_id": generate_tracking_id(), "channel_id": channel.id},
                )
                _log_channel_refresh_path(channel, refresh_mode, refresh_path, success=False)
                subscription.last_checked_at = now
                db.session.commit()
                processed_channels += 1
                yield {
                    "type": "channel_complete",
                    "channel_id": channel.id,
                    "yt_channel_id": channel.yt_channel_id,
                    "channel_title": channel.title,
                    "channel_new_videos": 0,
                    "channel_metadata_updates": 0,
                    "new_videos": new_videos,
                    "processed_channels": processed_channels,
                    "current_channel": index,
                    "total_channels": total_channels,
                    "success": False,
                }
                continue

        if refresh_result.get("fallback_to_api"):
            if not consume(settings, Config.YT_REFRESH_COST):
                db.session.commit()
                yield {
                    "type": "complete",
                    "new_videos": new_videos,
                    "rate_limited": False,
                    "processed_channels": processed_channels,
                    "total_channels": total_channels,
                    "blocked": True,
                    "reason": "quota_exhausted",
                }
                break

            refresh_path = "api_only" if refresh_mode == "api_only" else "api_fallback"
            response = service.get_channel_videos(channel.yt_channel_id)
            if response.get("rate_limited"):
                mark_quota_exhausted(settings)
                rate_limited = True
                _log_channel_refresh_path(channel, refresh_mode, f"{refresh_path}_rate_limited", success=False)
                db.session.commit()
                yield {
                    "type": "complete",
                    "new_videos": new_videos,
                    "rate_limited": True,
                    "processed_channels": processed_channels,
                    "total_channels": total_channels,
                    "blocked": True,
                    "reason": "upstream_rate_limited",
                }
                break
            if not response.get("success", True):
                logger.warning(
                    "Channel refresh failed.",
                    extra={"tracking_id": generate_tracking_id(), "channel_id": channel.id},
                )
                _log_channel_refresh_path(channel, refresh_mode, f"{refresh_path}_failed", success=False)
                subscription.last_checked_at = now
                db.session.commit()
                processed_channels += 1
                yield {
                    "type": "channel_complete",
                    "channel_id": channel.id,
                    "yt_channel_id": channel.yt_channel_id,
                    "channel_title": channel.title,
                    "channel_new_videos": 0,
                    "new_videos": new_videos,
                    "processed_channels": processed_channels,
                    "current_channel": index,
                    "total_channels": total_channels,
                    "success": False,
                }
                continue

            refresh_result = _ingest_api_items(
                channel,
                subscription,
                response,
                preset,
                recent_cutoff,
                older_min_cutoff,
                older_max_cutoff,
                ignore_last_refreshed,
            )
            refresh_result["success"] = True
            refresh_result["rate_limited"] = False
            refresh_result["used_api_fallback"] = True
        elif refresh_result.get("used_api_completion"):
            refresh_path = "rss+api_completion"
        elif refresh_result.get("used_rss"):
            refresh_path = "rss"

        if refresh_result.get("rate_limited"):
            rate_limited = True
            _log_channel_refresh_path(channel, refresh_mode, f"{refresh_path}_rate_limited", success=False)
            db.session.commit()
            yield {
                "type": "complete",
                "new_videos": new_videos,
                "rate_limited": True,
                "processed_channels": processed_channels,
                "total_channels": total_channels,
                "blocked": True,
                "reason": "upstream_rate_limited",
            }
            break

        latest_seen = refresh_result.get("latest_seen")
        channel_new_videos = refresh_result.get("channel_new_videos", 0)
        channel_metadata_updates = refresh_result.get("channel_metadata_updates", 0)
        new_videos += channel_new_videos

        if refresh_result.get("used_api_fallback"):
            logger.info(
                "Channel refresh used API fallback after RSS feed failure.",
                extra={"tracking_id": generate_tracking_id(), "channel_id": channel.id},
            )

        if latest_seen:
            subscription.last_refreshed_at = latest_seen
        subscription.last_checked_at = now

        _delete_older_than(channel.id, older_max_cutoff)
        _prune_range(channel.id, recent_cutoff, None, False, preset["recent_video_cap"])
        _prune_range(channel.id, recent_cutoff, None, True, preset["recent_short_cap"])
        _prune_range(channel.id, older_max_cutoff, older_min_cutoff, False, preset["older_video_cap"])
        _prune_range(channel.id, older_max_cutoff, older_min_cutoff, True, preset["older_short_cap"])

        db.session.commit()

        _log_channel_refresh_path(
            channel,
            refresh_mode,
            refresh_path,
            channel_new_videos=channel_new_videos,
            channel_metadata_updates=channel_metadata_updates,
            success=True,
        )

        if not ChannelCategory.query.filter_by(channel_id=channel.id).first():
            try:
                if classifier is None:
                    classifier = ClassificationService()
                classifier.classify_channel(channel)
            except Exception as error:
                logger.warning(
                    "Automatic channel classification after refresh failed: %s",
                    error,
                    extra={"tracking_id": generate_tracking_id(), "channel_id": channel.id},
                )

        processed_channels += 1
        yield {
            "type": "channel_complete",
            "channel_id": channel.id,
            "yt_channel_id": channel.yt_channel_id,
            "channel_title": channel.title,
            "channel_new_videos": channel_new_videos,
            "channel_metadata_updates": channel_metadata_updates,
            "new_videos": new_videos,
            "processed_channels": processed_channels,
            "current_channel": index,
            "total_channels": total_channels,
            "success": True,
        }
    else:
        yield {
            "type": "complete",
            "new_videos": new_videos,
            "rate_limited": rate_limited,
            "processed_channels": processed_channels,
            "total_channels": total_channels,
        }


def refresh_user_channels(user, settings, service, channel_id=None, ignore_last_refreshed=False, now=None):
    """Refresh videos for a user with per-channel caps."""
    summary = {
        "new_videos": 0,
        "rate_limited": False,
        "processed_channels": 0,
        "total_channels": 0,
    }
    for event in iter_refresh_user_channels(
        user,
        settings,
        service,
        channel_id=channel_id,
        ignore_last_refreshed=ignore_last_refreshed,
        now=now,
    ):
        if event.get("type") == "complete":
            summary.update(
                {
                    "new_videos": event.get("new_videos", 0),
                    "rate_limited": event.get("rate_limited", False),
                    "processed_channels": event.get("processed_channels", 0),
                    "total_channels": event.get("total_channels", 0),
                }
            )
    return summary
