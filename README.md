# App Store Reviews Daily Fetcher (MoMo)

Lấy **rating** + **comment** App Store về file CSV, lưu vào folder Google Drive. 100% free, không cần API key (dùng iTunes RSS + Lookup — nguồn Apple cho phép chính thức).

## Yêu cầu
- Node.js >= 18 (`node --version`). Không cần `npm install`, không có `node_modules`.

## Chạy
```bat
node fetch-appstore-reviews.js
```
Chạy zero-config: output mặc định đã set sẵn `G:\Shared drives\GMC-N2MM-N8N\APP_STORE_APP_RATING`.
Scheduling daily: dùng routine của bạn để gọi đúng lệnh trên mỗi ngày.

## Cấu hình (tuỳ chọn, override bằng env var)
| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `APPSTORE_OUTPUT_DIR` | `G:\Shared drives\GMC-N2MM-N8N\APP_STORE_APP_RATING` | Folder output |
| `APPSTORE_APP_ID` | `918751511` | App id MoMo iOS |
| `APPSTORE_COUNTRIES` | `vn` | Nhiều market: `vn,us,sg` |
| `APPSTORE_MAX_PAGES` | `10` | Số trang RSS / country (~50 review/trang) |

## Output
| File | Nội dung |
|---|---|
| `reviews.ndjson` | **Source of truth** — append-only, dedup theo `review_id` |
| `appstore_reviews.csv` | Bảng review đầy đủ (UTF-8), regenerate mỗi lần chạy — load BigQuery / Looker |
| `rating_snapshots.ndjson` / `.csv` | 1 dòng / (ngày, country): `average_rating`, `rating_count`, version |

Cột `appstore_reviews.csv`: `review_id, app_id, country, rating, title, content, author, app_version, review_updated_at, first_seen_date`

## Lưu ý
- RSS chỉ trả ~500 review **mới nhất** / country và chỉ review **có text** — đủ cho daily delta. Cần backfill toàn bộ lịch sử → xin `.p8` key, dùng App Store Connect API (bước sau).
- CSV ghi **UTF-8 không BOM** → tránh lỗi encoding kiểu UTF-16 khi load BigQuery.
- Dedup bằng `review_id`, có surrogate key dự phòng khi thiếu id.
- Test logic: `node test.js`.

## Bước tiếp (nối BigQuery)
Giống pipeline Google Play: Drive → staging → `DELETE WHERE TRUE` + INSERT. CSV đã sẵn schema phẳng để load thẳng.
