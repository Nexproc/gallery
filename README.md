# lightsync-gallery

Static single-page photography gallery published via GitHub Pages (`https://www.nicktitcombe.com/lightsync-gallery/`) and backed by Google Cloud Storage (`3k_exports` + `thumbs`).

## Features

- **Highlights-First Curation & Views:** Lands on a curated `Highlights` (`4★+`) editorial reel with instant switching to `Shoots` (automatic `> 24h` capture-session cover cards with drill-down), `Archive` (every photograph), and browser-saved `Favorites`.
- **Editorial Spreads ↔ Contact Sheet Density Toggle:** Switch between full-bleed asymmetric Hero spreads / justified rows and a compact zero-crop Contact Sheet (~6–9 photos per row) while preserving scroll position on the exact photograph in view.
- **Virtualized Reel & 2-Tier Thumbnails for 2k–10k+ Archives:** Pre-computes exact pixel coordinates up front, mounts only rows near the viewport, evicts offscreen decoded bitmaps via LRU, hydrates `800px` WebP grid thumbnails (`thumbs/*.webp`) with automatic fallback to `3k_exports` masters, and serves full 3K resolution in the Hero cover and Lightbox.
- **Hierarchical Month → Day Timeline:** Automatically groups sticky navigation pills by month and expands active-month day sub-ticks on the right-edge timeline scrubber across multi-month archives.
- **Live Deep-Link URLs & Native/Clipboard Sharing:** Continuously reflects the active reel (`?view=`), shoot (`?shoot=`), scroll position (`?date=`, `?at=`), shared `Favorites` (`?picks=`), and active Lightbox photograph (`?photo=`) in the address bar, with one-click Share actions on the toolbar, shoot headers, photo cards, and Lightbox (`S`).
- **Proximity-Scaled Hero Carousel & Zoom Lightbox:** Full-bleed opening cover (`5★` orientation-matched slides anchored to XMP AI mask `ReferencePoint` coordinates) with 2× cursor-proximity magnification, touch scrubbing, cursor-panning zoom (`Z`), keyboard navigation (`←`, `→`, `F`, `S`, `Esc`), and direct downloads.

---

## Sync Google Drive `3k_exports` → Google Cloud Storage

`scripts/sync_drive_to_gcs.py` incrementally syncs photographs to `gs://<BUCKET>/3k_exports/`, generates `800px` WebP grid thumbnails in `gs://<BUCKET>/thumbs/`, prunes stale objects, applies `scripts/gcs-cors.json`, and publishes `manifest.json` with compact `24px` WebP blur-up placeholders.

1. **Authorize Drive read + GCS access once:**
   ```bash
   pip install Pillow
   gcloud auth application-default login \
     --scopes="https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/devstorage.full_control"
   ```

2. **Sync Drive folder → GCS bucket & update `manifest.json`:**
   ```bash
   export BUCKET="your-gcs-bucket-name"

   python3 scripts/sync_drive_to_gcs.py --bucket "$BUCKET"
   ```

3. **Commit `manifest.json` once** (so the repository points to `https://storage.googleapis.com/$BUCKET/manifest.json`):
   ```bash
   git add manifest.json
   git commit -m "Configure GCS bucket URL in manifest.json"
   git push
   ```
   After `remoteManifestUrl` is committed once, future syncs update the live gallery immediately without needing a new git commit.

4. **Sync Lightroom star ratings, XMP focal points & backfill `800px` WebP thumbnails (no 3K JPEG re-upload):**
   ```bash
   python3 scripts/sync_drive_to_gcs.py \
     --bucket "$BUCKET" \
     --manifest-only \
     --backfill-thumbs \
     --exif-from-dir /path/to/raws_or_finished_library \
     --lrcat "/path/to/Lightroom Catalog.lrcat"
   ```
   *(Pass `--local-dir /path/to/3k_exports` alongside `--manifest-only --backfill-thumbs` if you want thumbnails generated from local JPEGs rather than fetched from GCS.)*

---

## Sync Directly from a Local Folder → GCS

If your exported JPEGs are stored locally, pass `--local-dir` to upload new/changed 3K JPEGs and `800px` WebP thumbnails straight from disk to GCS (skipping unchanged files via MD5 check):

```bash
python3 scripts/sync_drive_to_gcs.py \
  --bucket "$BUCKET" \
  --local-dir /path/to/3k_exports \
  --exif-from-dir /path/to/raws_or_finished_library \
  --lrcat "/path/to/Lightroom Catalog.lrcat"
```
*(Offline manifest + thumbnail generation without uploading to GCS is also available via `python3 scripts/build_manifest.py --images-dir /path/to/3k_exports --thumbs-dir ./thumbs --out manifest.json`.)*


