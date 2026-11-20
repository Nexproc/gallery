#!/usr/bin/env python3
"""Generate static Open Graph / Twitter Card preview pages (/p/<id>/ and /s/<shoot_id>/) for GitHub Pages."""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import math
import re
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_SITE_URL = "https://www.nicktitcombe.com/gallery"
DEFAULT_MANIFEST_URL = "https://storage.googleapis.com/lightsync-gallery-media-8f4a2c/manifest.json"
SESSION_GAP_SECONDS = 24 * 60 * 60

SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
LONG_MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
]


def compute_photo_asset_version(photo: dict[str, Any]) -> str:
    """Match getPhotoAssetVersion(photo) in app.js (32-bit FNV-1a hex)."""
    raw = f"{photo.get('ver') or ''}|{photo.get('width') or 0}x{photo.get('height') or 0}|{photo.get('lqip') or ''}"
    h = 0x811C9DC5
    for ch in raw:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def guess_mime(filename: str) -> str:
    lower = filename.lower()
    if lower.endswith(".webp"):
        return "image/webp"
    if lower.endswith(".png"):
        return "image/png"
    if lower.endswith(".avif"):
        return "image/avif"
    return "image/jpeg"


def resolve_master_url(photo: dict[str, Any], asset_base_url: str) -> str:
    if photo.get("url") and str(photo["url"]).startswith(("http://", "https://")):
        base_u = str(photo["url"])
    else:
        fn = urllib.parse.quote(str(photo.get("filename") or f"{photo['id']}.jpg"))
        base_u = f"{asset_base_url.rstrip('/')}/{fn}"
    ver = compute_photo_asset_version(photo)
    sep = "&" if "?" in base_u else "?"
    return f"{base_u}{sep}v={ver}"


def estimate_hex_luminance(hex_color: Any) -> float:
    s = str(hex_color or "")
    if not re.match(r"^#[0-9a-fA-F]{6}$", s):
        return 64.0
    r = int(s[1:3], 16)
    g = int(s[3:5], 16)
    b = int(s[5:7], 16)
    return 0.299 * r + 0.587 * g + 0.114 * b


def is_well_exposed(photo: dict[str, Any]) -> bool:
    return estimate_hex_luminance(photo.get("dominantColor")) >= 26.0 and len(str(photo.get("lqip") or "")) >= 100


def pick_default_cover_photo(photos: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not photos:
        return None
    rated = [p for p in photos if isinstance(p.get("rating"), (int, float)) and p["rating"] > 0]
    if rated:
        max_r = max(int(p["rating"]) for p in rated)
        top = [p for p in photos if p.get("rating") == max_r]
        oriented = [p for p in top if p.get("orientation") == "landscape"]
        pool = oriented or top
    else:
        heroes = [p for p in photos if p.get("hero") and p.get("orientation") == "landscape"]
        pool = heroes or [p for p in photos if p.get("orientation") == "landscape"] or photos
    bright = [p for p in pool if is_well_exposed(p)]
    return (bright or pool)[0]


def parse_ymd(ymd: str) -> tuple[int, int, int] | None:
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", str(ymd or ""))
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


def format_single_date(ymd: str) -> str:
    parts = parse_ymd(ymd)
    if not parts:
        return ymd
    y, m, d = parts
    if 1 <= m <= 12:
        return f"{LONG_MONTHS[m - 1]} {d}, {y}"
    return ymd


def format_shoot_date_range(oldest: str, newest: str) -> str:
    a = parse_ymd(oldest)
    b = parse_ymd(newest)
    if not a or not b:
        return newest or oldest or ""
    if oldest == newest:
        return f"{LONG_MONTHS[b[1] - 1]} {b[2]}, {b[0]}"
    if a[0] == b[0] and a[1] == b[1]:
        return f"{LONG_MONTHS[a[1] - 1]} {a[2]}–{b[2]}, {a[0]}"
    if a[0] == b[0]:
        return f"{SHORT_MONTHS[a[1] - 1]} {a[2]} – {SHORT_MONTHS[b[1] - 1]} {b[2]}, {a[0]}"
    return f"{SHORT_MONTHS[a[1] - 1]} {a[2]}, {a[0]} – {SHORT_MONTHS[b[1] - 1]} {b[2]}, {b[0]}"


def parse_photo_ts_seconds(photo: dict[str, Any]) -> float | None:
    ts = str(photo.get("timestamp") or "").strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})", ts)
    if not m:
        return None
    try:
        d = dt.datetime(
            int(m.group(1)),
            int(m.group(2)),
            int(m.group(3)),
            int(m.group(4)),
            int(m.group(5)),
            int(m.group(6)),
            tzinfo=dt.timezone.utc,
        )
        return d.timestamp()
    except ValueError:
        return None


def build_shoots(photos: list[dict[str, Any]]) -> list[dict[str, Any]]:
    sessions: list[list[dict[str, Any]]] = []
    for idx, p in enumerate(photos):
        if idx == 0:
            sessions.append([p])
            continue
        t_prev = parse_photo_ts_seconds(photos[idx - 1])
        t_curr = parse_photo_ts_seconds(p)
        if t_prev is not None and t_curr is not None and math.isfinite(t_prev) and math.isfinite(t_curr):
            if abs(t_prev - t_curr) > SESSION_GAP_SECONDS:
                sessions.append([p])
                continue
        sessions[-1].append(p)

    shoots: list[dict[str, Any]] = []
    for sp in sessions:
        if not sp:
            continue
        newest = sp[0]
        oldest = sp[-1]
        shoot_id = f"{newest['date']}_{newest['id']}"
        best_cover = max(
            sp,
            key=lambda x: (
                (float(x["rating"]) * 12.0 if isinstance(x.get("rating"), (int, float)) else 0.0)
                + (5.0 if x.get("hero") else 0.0)
                + (3.0 if is_well_exposed(x) else 0.0)
                + (1.5 if x.get("orientation") == "landscape" else 0.0)
            ),
        )
        count = len(sp)
        shoots.append(
            {
                "id": shoot_id,
                "title": format_shoot_date_range(str(oldest.get("date") or ""), str(newest.get("date") or "")),
                "count": count,
                "countLabel": "1 photograph" if count == 1 else f"{count:,} photographs",
                "cover": best_cover,
            }
        )
    return shoots


def render_stub_html(
    *,
    site_name: str,
    og_title: str,
    og_desc: str,
    canonical_url: str,
    image_url: str,
    image_mime: str,
    image_width: int,
    image_height: int,
    image_alt: str,
    apple_icon_url: str,
    redirect_js: str,
    noscript_href: str,
) -> str:
    e_site = html.escape(site_name, quote=True)
    e_title = html.escape(og_title, quote=True)
    e_desc = html.escape(og_desc, quote=True)
    e_url = html.escape(canonical_url, quote=True)
    e_img = html.escape(image_url, quote=True)
    e_mime = html.escape(image_mime, quote=True)
    e_alt = html.escape(image_alt, quote=True)
    e_apple = html.escape(apple_icon_url, quote=True)
    e_noscript = html.escape(noscript_href, quote=True)

    return (
        "<!DOCTYPE html>\n"
        '<html lang="en">\n'
        "<head>\n"
        '  <meta charset="UTF-8" />\n'
        '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n'
        f"  <title>{e_title}</title>\n"
        f'  <meta name="description" content="{e_desc}" />\n'
        '  <link rel="icon" href="../../favicon.ico?v=3" sizes="any" />\n'
        '  <link rel="icon" type="image/png" sizes="32x32" href="../../icon-32.png?v=3" />\n'
        f'  <link rel="apple-touch-icon" sizes="180x180" href="{e_apple}" />\n'
        '  <meta property="og:type" content="website" />\n'
        f'  <meta property="og:site_name" content="{e_site}" />\n'
        f'  <meta property="og:title" content="{e_title}" />\n'
        f'  <meta property="og:description" content="{e_desc}" />\n'
        f'  <meta property="og:url" content="{e_url}" />\n'
        f'  <meta property="og:image" content="{e_img}" />\n'
        f'  <meta property="og:image:secure_url" content="{e_img}" />\n'
        f'  <meta property="og:image:type" content="{e_mime}" />\n'
        f'  <meta property="og:image:width" content="{image_width}" />\n'
        f'  <meta property="og:image:height" content="{image_height}" />\n'
        f'  <meta property="og:image:alt" content="{e_alt}" />\n'
        '  <meta name="twitter:card" content="summary_large_image" />\n'
        f'  <meta name="twitter:title" content="{e_title}" />\n'
        f'  <meta name="twitter:description" content="{e_desc}" />\n'
        f'  <meta name="twitter:image" content="{e_img}" />\n'
        f"  <script>{redirect_js}</script>\n"
        "</head>\n"
        "<body>\n"
        f'  <noscript><p><a href="{e_noscript}">Open in {e_site}</a></p></noscript>\n'
        "</body>\n"
        "</html>\n"
    )


def update_root_og_tags(
    html_path: Path,
    *,
    site_name: str,
    og_desc: str,
    site_url: str,
    cover_url: str,
    cover_mime: str,
    cover_w: int,
    cover_h: int,
) -> None:
    if not html_path.exists():
        return
    text = html_path.read_text(encoding="utf-8")
    og_block = (
        "  <!-- Open Graph & Chat Preview Metadata -->\n"
        '  <meta property="og:type" content="website" />\n'
        f'  <meta property="og:site_name" content="{html.escape(site_name, quote=True)}" />\n'
        f'  <meta property="og:title" content="{html.escape(site_name, quote=True)}" />\n'
        f'  <meta property="og:description" content="{html.escape(og_desc, quote=True)}" />\n'
        f'  <meta property="og:url" content="{html.escape(site_url.rstrip("/") + "/", quote=True)}" />\n'
        f'  <meta property="og:image" content="{html.escape(cover_url, quote=True)}" />\n'
        f'  <meta property="og:image:secure_url" content="{html.escape(cover_url, quote=True)}" />\n'
        f'  <meta property="og:image:type" content="{html.escape(cover_mime, quote=True)}" />\n'
        f'  <meta property="og:image:width" content="{cover_w}" />\n'
        f'  <meta property="og:image:height" content="{cover_h}" />\n'
        '  <meta name="twitter:card" content="summary_large_image" />\n'
        f'  <meta name="twitter:title" content="{html.escape(site_name, quote=True)}" />\n'
        f'  <meta name="twitter:description" content="{html.escape(og_desc, quote=True)}" />\n'
        f'  <meta name="twitter:image" content="{html.escape(cover_url, quote=True)}" />'
    )
    pattern = re.compile(
        r"  <!-- Open Graph & Chat Preview Metadata -->.*?<meta name=\"twitter:image\"[^>]*/>",
        flags=re.DOTALL,
    )
    if pattern.search(text):
        text = pattern.sub(og_block, text, count=1)
        html_path.write_text(text, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-dir", type=Path, required=True, help="Output _site directory")
    parser.add_argument("--site-url", default=DEFAULT_SITE_URL, help="Public gallery base URL")
    parser.add_argument("--manifest-file", type=Path, default=None, help="Optional local manifest.json")
    parser.add_argument("--manifest-url", default=DEFAULT_MANIFEST_URL, help="Remote manifest.json URL")
    args = parser.parse_args()

    if args.manifest_file and args.manifest_file.exists():
        manifest = json.loads(args.manifest_file.read_text(encoding="utf-8"))
    else:
        with urllib.request.urlopen(args.manifest_url, timeout=60) as resp:
            manifest = json.loads(resp.read().decode("utf-8"))

    coll = manifest.get("collection") or {}
    raw_photos: list[dict[str, Any]] = list(manifest.get("photos") or [])
    photos = sorted(
        raw_photos,
        key=lambda p: (str(p.get("timestamp") or ""), str(p.get("id") or "")),
        reverse=True,
    )

    site_url = args.site_url.rstrip("/")
    site_name = str(coll.get("title") or "Gallery").strip() or "Gallery"
    asset_base_url = str(coll.get("assetBaseUrl") or f"{site_url}/3k_exports")
    apple_icon_url = f"{site_url}/apple-touch-icon.png?v=3"

    total_photos = len(photos)
    date_range = str(coll.get("dateRange") or "").strip()
    root_desc = (
        f"{total_photos:,} photographs · {date_range}"
        if date_range and total_photos
        else f"Photography collection ({total_photos:,} photographs)"
    )

    cover_photo = pick_default_cover_photo(photos)
    if cover_photo:
        cover_url = resolve_master_url(cover_photo, asset_base_url)
        cover_fn = str(cover_photo.get("filename") or f"{cover_photo['id']}.jpg")
        cover_mime = guess_mime(cover_fn)
        cover_w = int(cover_photo.get("width") or 3000)
        cover_h = int(cover_photo.get("height") or 2000)
        update_root_og_tags(
            args.site_dir / "index.html",
            site_name=site_name,
            og_desc=root_desc,
            site_url=site_url,
            cover_url=cover_url,
            cover_mime=cover_mime,
            cover_w=cover_w,
            cover_h=cover_h,
        )
        update_root_og_tags(
            args.site_dir / "404.html",
            site_name=site_name,
            og_desc=root_desc,
            site_url=site_url,
            cover_url=cover_url,
            cover_mime=cover_mime,
            cover_w=cover_w,
            cover_h=cover_h,
        )

    p_root = args.site_dir / "p"
    p_root.mkdir(parents=True, exist_ok=True)

    photo_count = 0
    for photo in photos:
        pid = str(photo.get("id") or "").strip()
        if not pid or "/" in pid or pid in (".", ".."):
            continue
        fn = str(photo.get("filename") or f"{pid}.jpg")
        img_url = resolve_master_url(photo, asset_base_url)
        img_mime = guess_mime(fn)
        w = int(photo.get("width") or 3000)
        h = int(photo.get("height") or 2000)
        date_str = format_single_date(str(photo.get("date") or ""))
        og_title = f"{site_name} — {date_str}" if date_str else f"{site_name} — {pid}"
        og_desc = f"{pid} · {date_str}" if date_str else pid
        canonical = f"{site_url}/p/{urllib.parse.quote(pid)}/"

        pid_js = json.dumps(pid)
        redirect_js = (
            "(function(){"
            "var q=new URLSearchParams(window.location.search);"
            f"q.set('photo',{pid_js});"
            "window.location.replace('../../?'+q.toString()+window.location.hash);"
            "})();"
        )
        noscript_href = f"../../?photo={urllib.parse.quote(pid)}"

        stub_dir = p_root / pid
        stub_dir.mkdir(parents=True, exist_ok=True)
        (stub_dir / "index.html").write_text(
            render_stub_html(
                site_name=site_name,
                og_title=og_title,
                og_desc=og_desc,
                canonical_url=canonical,
                image_url=img_url,
                image_mime=img_mime,
                image_width=w,
                image_height=h,
                image_alt=fn,
                apple_icon_url=apple_icon_url,
                redirect_js=redirect_js,
                noscript_href=noscript_href,
            ),
            encoding="utf-8",
        )
        photo_count += 1

    shoots = build_shoots(photos)
    s_root = args.site_dir / "s"
    s_root.mkdir(parents=True, exist_ok=True)

    shoot_count = 0
    for shoot in shoots:
        sid = str(shoot["id"]).strip()
        if not sid or "/" in sid or sid in (".", ".."):
            continue
        cover = shoot["cover"]
        fn = str(cover.get("filename") or f"{cover['id']}.jpg")
        img_url = resolve_master_url(cover, asset_base_url)
        img_mime = guess_mime(fn)
        w = int(cover.get("width") or 3000)
        h = int(cover.get("height") or 2000)
        s_title = f"{site_name} — {shoot['title']}" if shoot["title"] else site_name
        s_desc = shoot["countLabel"]
        canonical = f"{site_url}/s/{urllib.parse.quote(sid)}/"

        sid_js = json.dumps(sid)
        redirect_js = (
            "(function(){"
            "var q=new URLSearchParams(window.location.search);"
            "q.set('view','shoots');"
            f"q.set('shoot',{sid_js});"
            "window.location.replace('../../?'+q.toString()+window.location.hash);"
            "})();"
        )
        noscript_href = f"../../?view=shoots&shoot={urllib.parse.quote(sid)}"

        stub_dir = s_root / sid
        stub_dir.mkdir(parents=True, exist_ok=True)
        (stub_dir / "index.html").write_text(
            render_stub_html(
                site_name=site_name,
                og_title=s_title,
                og_desc=s_desc,
                canonical_url=canonical,
                image_url=img_url,
                image_mime=img_mime,
                image_width=w,
                image_height=h,
                image_alt=fn,
                apple_icon_url=apple_icon_url,
                redirect_js=redirect_js,
                noscript_href=noscript_href,
            ),
            encoding="utf-8",
        )
        shoot_count += 1

    print(
        f"Generated {photo_count:,} photo share previews (/p/<id>/) and "
        f"{shoot_count:,} shoot share previews (/s/<id>/) in {args.site_dir}"
    )


if __name__ == "__main__":
    main()
