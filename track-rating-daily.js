#!/usr/bin/env node
/**
 * App Store rating-count tracker theo ngày (free, no auth, no token).
 *
 * Nguồn: HTML server-rendered của apps.apple.com nhúng sẵn
 *   "totalNumberOfRatings": N, "ratingCounts": [5★, 4★, 3★, 2★, 1★]   (số LŨY KẾ)
 *
 * Chạy hôm nay -> gắn nhãn ngày D-1 (chốt số liệu của HÔM QUA).
 * Mỗi ngày ghi 2 file CSV (long format: date, star, count), TÊN FILE = NGÀY D-1:
 *   <outputDir>\rating_log\<D-1>.csv    -> snapshot LŨY KẾ gắn nhãn D-1 (5 dòng)
 *   <outputDir>\rating_daily\<D-1>.csv  -> rating MỚI = (D-1) - (D-2) theo sao (5 dòng)
 *
 * Source of truth = tập các file trong rating_log\ (đọc lại để tính delta).
 * Yêu cầu: Node.js >= 18 (global fetch). Không cần npm install.
 */

const fs = require('fs');
const path = require('path');

const CONFIG = {
  appId: process.env.APPSTORE_APP_ID || '918751511',                // MoMo iOS
  country: process.env.APPSTORE_COUNTRY || 'vn',
  outputDir: process.env.APPSTORE_OUTPUT_DIR || 'G:\\Shared drives\\GMC-N2MM-N8N\\APP_STORE_APP_RATING',
  timezone: 'Asia/Ho_Chi_Minh',
};

const STARS = [1, 2, 3, 4, 5];
const DATE_RE = /^(\d{4}-\d{2}-\d{2})\.csv$/;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Ngày báo cáo = D-1: chạy hôm nay nhưng số liệu/đặt tên file theo HÔM QUA.
function reportDate(tz) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD theo tz
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function fetchRatingCounts(appId, country, tries = 3) {
  const url = `https://apps.apple.com/${country}/app/id${appId}`;
  let html;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
      break;
    } catch (err) {
      if (i === tries) throw err;
      await sleep(800 * i);
    }
  }
  // ratingCounts theo thứ tự [5★, 4★, 3★, 2★, 1★]
  // Số có thể ở dạng số nguyên hoặc thập phân (vd 5914.000000000001) -> chấp nhận rồi làm tròn.
  const num = '(\\d+(?:\\.\\d+)?)';
  const m = html.match(
    new RegExp(`"totalNumberOfRatings":${num},"context":"productPage","ratingCounts":\\[${num},${num},${num},${num},${num}\\]`)
  );
  if (!m) {
    throw new Error('Không tìm thấy ratingCounts trong HTML (cấu trúc trang có thể đã thay đổi).');
  }
  const counts = { 5: Math.round(+m[2]), 4: Math.round(+m[3]), 3: Math.round(+m[4]), 2: Math.round(+m[5]), 1: Math.round(+m[6]) };
  const total = Math.round(+m[1]);
  const sum = STARS.reduce((a, s) => a + counts[s], 0);
  if (sum !== total) {
    console.warn(`  ⚠ tổng theo sao (${sum}) != totalNumberOfRatings (${total}) — vẫn dùng số theo sao.`);
  }
  return { counts, total };
}

// ---------- CSV I/O (long format: date,star,count) ----------

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Ghi 1 file CSV cho 1 ngày: 5 dòng (sao 1..5). */
function writeDayCsv(file, date, counts) {
  const lines = ['date,star,count'];
  for (const s of STARS) lines.push(`${date},${s},${counts[s] ?? ''}`);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8'); // UTF-8 không BOM
}

/** Đọc 1 file CSV ngày -> {1..5: count}. */
function readDayCsv(file) {
  const counts = {};
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = 1; i < lines.length; i++) {            // bỏ header
    const [, star, count] = lines[i].split(',');
    if (star) counts[+star] = +count;
  }
  return counts;
}

/** Liệt kê các ngày đã có file log (sắp tăng dần). */
function listLogDates(logDir) {
  if (!fs.existsSync(logDir)) return [];
  return fs.readdirSync(logDir)
    .map(f => (f.match(DATE_RE) || [])[1])
    .filter(Boolean)
    .sort();
}

// ---------- main ----------

async function main() {
  const date = reportDate(CONFIG.timezone); // = D-1 (chốt số liệu hôm qua)
  const logDir = path.join(CONFIG.outputDir, 'rating_log');
  const dailyDir = path.join(CONFIG.outputDir, 'rating_daily');
  ensureDir(logDir);
  ensureDir(dailyDir);

  console.log(`App ${CONFIG.appId} | country: ${CONFIG.country} | date: ${date}`);

  const { counts, total } = await fetchRatingCounts(CONFIG.appId, CONFIG.country);
  console.log(`  Lũy kế (chốt cho ${date}, D-1): total=${total} | ` + STARS.map(s => `${s}★:${counts[s]}`).join(' '));

  // ngày D-2 = file log gần nhất trước ngày báo cáo (lấy TRƯỚC khi ghi file D-1)
  const prevDate = listLogDates(logDir).filter(d => d < date).pop();

  // 1) log lũy kế gắn nhãn D-1 (ghi đè nếu chạy lại trong ngày)
  writeDayCsv(path.join(logDir, `${date}.csv`), date, counts);

  // 2) daily = (D-1) - (D-2)
  if (prevDate) {
    const prev = readDayCsv(path.join(logDir, `${prevDate}.csv`));
    const dailyCounts = {};
    for (const s of STARS) dailyCounts[s] = (counts[s] ?? 0) - (prev[s] ?? 0);
    writeDayCsv(path.join(dailyDir, `${date}.csv`), date, dailyCounts);
    const newTotal = STARS.reduce((a, s) => a + dailyCounts[s], 0);
    console.log(`  Daily (so với ${prevDate}): +${newTotal} rating | ` + STARS.map(s => `${s}★:${dailyCounts[s]}`).join(' '));
  } else {
    console.log('  Daily: chưa có ngày trước đó -> hôm nay là mốc nền (chưa tạo file daily).');
  }

  console.log(`\nXong. Output:\n  ${path.join(logDir, `${date}.csv`)}` +
    (prevDate ? `\n  ${path.join(dailyDir, `${date}.csv`)}` : ''));
}

if (require.main === module) {
  main().catch(err => {
    console.error('FAILED:', err.message);
    process.exit(1);
  });
}

module.exports = { fetchRatingCounts, writeDayCsv, readDayCsv, listLogDates };
