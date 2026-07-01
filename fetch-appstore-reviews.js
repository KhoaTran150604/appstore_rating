#!/usr/bin/env node
/**
 * App Store daily review + rating fetcher (RSS + iTunes Lookup, 100% free, no auth).
 *
 * - Reviews:  https://itunes.apple.com/{country}/rss/customerreviews/page={n}/id={appId}/sortby=mostrecent/json
 *             -> tối đa ~50 review/trang, 10 trang -> ~500 review mới nhất / country
 * - Rating:   https://itunes.apple.com/lookup?id={appId}&country={country}
 *             -> averageUserRating + userRatingCount (snapshot theo ngày)
 *
 * Source of truth = NDJSON (append-only, dedup theo review_id).
 * Mỗi lần chạy regenerate CSV UTF-8 từ NDJSON cho Drive / BigQuery.
 *
 * Yêu cầu: Node.js >= 18 (có global fetch). Không cần npm install.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG = {
  appId: process.env.APPSTORE_APP_ID || '918751511',                 // MoMo iOS (M-SERVICE JSC)
  countries: (process.env.APPSTORE_COUNTRIES || 'vn').split(',').map(s => s.trim()).filter(Boolean),
  maxPages: Number(process.env.APPSTORE_MAX_PAGES || 10),
  // Folder output (Google Drive Shared drive sync). Có thể override bằng env APPSTORE_OUTPUT_DIR.
  outputDir: process.env.APPSTORE_OUTPUT_DIR || 'G:\\Shared drives\\GMC-N2MM-N8N\\APP_STORE_APP_RATING',
  timezone: 'Asia/Ho_Chi_Minh',
  requestDelayMs: 400,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Ngày báo cáo = D-1: chạy hôm nay nhưng gắn nhãn dữ liệu theo HÔM QUA.
function reportDate(tz) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // en-CA => YYYY-MM-DD
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function fetchJson(url, tries = 2) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'momo-gmc-appstore-fetcher/1.0', 'Accept': 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === tries) throw err;
      await sleep(800 * i);
    }
  }
}

/** Lấy text content từ entry.content (object hoặc array, ưu tiên type=text). */
function extractContent(content) {
  if (!content) return '';
  if (Array.isArray(content)) {
    const textBlock = content.find(c => c?.attributes?.type === 'text') || content[0];
    return textBlock?.label || '';
  }
  return content.label || '';
}

/** Chuẩn hoá 1 entry RSS -> review object, hoặc null nếu không phải review (vd entry app-info). */
function normalizeEntry(entry, appId, country) {
  // App-info entry không có im:rating -> bỏ
  if (!entry || !entry['im:rating']) return null;

  const reviewId =
    entry.id?.label ||
    crypto
      .createHash('md5')
      .update([entry.author?.name?.label, entry.updated?.label, entry.title?.label].join('|'))
      .digest('hex'); // surrogate key dự phòng khi thiếu id

  return {
    review_id: String(reviewId),
    app_id: String(appId),
    country,
    rating: parseInt(entry['im:rating'].label, 10) || null,
    title: entry.title?.label || '',
    content: extractContent(entry.content),
    author: entry.author?.name?.label || '',
    app_version: entry['im:version']?.label || '',
    review_updated_at: entry.updated?.label || '',
  };
}

async function fetchReviews(appId, country, maxPages) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://itunes.apple.com/${country}/rss/customerreviews/page=${page}/id=${appId}/sortby=mostrecent/json`;
    let data;
    try {
      data = await fetchJson(url);
    } catch (err) {
      console.warn(`  [${country}] page ${page} lỗi: ${err.message} -> dừng country này`);
      break;
    }
    const raw = data?.feed?.entry;
    const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const reviews = entries.map(e => normalizeEntry(e, appId, country)).filter(Boolean);
    if (reviews.length === 0) break; // hết review
    out.push(...reviews);
    await sleep(CONFIG.requestDelayMs);
  }
  return out;
}

async function fetchRatingSnapshot(appId, country, snapshotDate) {
  const url = `https://itunes.apple.com/lookup?id=${appId}&country=${country}`;
  const data = await fetchJson(url);
  const r = data?.results?.[0];
  if (!r) return null;
  return {
    snapshot_date: snapshotDate,
    app_id: String(appId),
    country,
    average_rating: r.averageUserRating ?? null,
    rating_count: r.userRatingCount ?? null,
    average_rating_current_version: r.averageUserRatingForCurrentVersion ?? null,
    rating_count_current_version: r.userRatingCountForCurrentVersion ?? null,
    app_version: r.version || '',
  };
}

// ---------- I/O helpers ----------

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readNdjson(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

function appendNdjson(file, records) {
  if (records.length === 0) return;
  fs.appendFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file, headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map(h => csvEscape(row[h])).join(','));
  // UTF-8 không BOM (tránh lỗi encoding kiểu UTF-16 khi load BigQuery)
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

// ---------- main ----------

async function main() {
  const snapshotDate = reportDate(CONFIG.timezone); // = D-1 (gắn nhãn dữ liệu hôm qua)
  ensureDir(CONFIG.outputDir);

  const reviewsNdjson = path.join(CONFIG.outputDir, 'reviews.ndjson');
  const reviewsCsv = path.join(CONFIG.outputDir, 'appstore_reviews.csv');
  const snapNdjson = path.join(CONFIG.outputDir, 'rating_snapshots.ndjson');
  const snapCsv = path.join(CONFIG.outputDir, 'rating_snapshots.csv');

  console.log(`App ${CONFIG.appId} | countries: ${CONFIG.countries.join(', ')} | date: ${snapshotDate}`);

  // --- Reviews: dedup theo review_id ---
  const existing = readNdjson(reviewsNdjson);
  const seen = new Map(existing.map(r => [r.review_id, r]));

  let fetchedTotal = 0;
  const newRecords = [];
  for (const country of CONFIG.countries) {
    const reviews = await fetchReviews(CONFIG.appId, country, CONFIG.maxPages);
    fetchedTotal += reviews.length;
    for (const rev of reviews) {
      if (!seen.has(rev.review_id)) {
        rev.first_seen_date = snapshotDate;
        seen.set(rev.review_id, rev);
        newRecords.push(rev);
      }
    }
    console.log(`  [${country}] fetched ${reviews.length} review`);
  }

  appendNdjson(reviewsNdjson, newRecords);

  const reviewHeaders = [
    'review_id', 'app_id', 'country', 'rating', 'title', 'content',
    'author', 'app_version', 'review_updated_at', 'first_seen_date',
  ];
  const allReviews = Array.from(seen.values()).sort(
    (a, b) => String(b.review_updated_at).localeCompare(String(a.review_updated_at))
  );
  writeCsv(reviewsCsv, reviewHeaders, allReviews);

  // --- Rating snapshot: 1 dòng / (ngày, country) ---
  const snapHeaders = [
    'snapshot_date', 'app_id', 'country', 'average_rating', 'rating_count',
    'average_rating_current_version', 'rating_count_current_version', 'app_version',
  ];
  const snaps = readNdjson(snapNdjson);
  const snapKey = s => `${s.snapshot_date}|${s.country}`;
  const snapSeen = new Map(snaps.map(s => [snapKey(s), s]));
  for (const country of CONFIG.countries) {
    try {
      const snap = await fetchRatingSnapshot(CONFIG.appId, country, snapshotDate);
      if (snap) {
        snapSeen.set(snapKey(snap), snap); // overwrite nếu chạy lại trong ngày
        console.log(`  [${country}] rating ${snap.average_rating} / ${snap.rating_count} ratings (v${snap.app_version})`);
      }
    } catch (err) {
      console.warn(`  [${country}] lookup lỗi: ${err.message}`);
    }
  }
  const allSnaps = Array.from(snapSeen.values()).sort(
    (a, b) => snapKey(a).localeCompare(snapKey(b))
  );
  // rewrite cả ndjson lẫn csv của snapshot (đảm bảo dedup theo ngày)
  fs.writeFileSync(snapNdjson, allSnaps.map(s => JSON.stringify(s)).join('\n') + '\n', 'utf8');
  writeCsv(snapCsv, snapHeaders, allSnaps);

  console.log(
    `\nXong: fetched ${fetchedTotal} | review mới ${newRecords.length} | tổng review ${allReviews.length}`
  );
  console.log(`Output: ${CONFIG.outputDir}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('FAILED:', err);
    process.exit(1);
  });
}

module.exports = { normalizeEntry, extractContent, csvEscape, writeCsv, readNdjson };
