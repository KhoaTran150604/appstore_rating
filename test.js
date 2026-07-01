const assert = require('assert');
const { normalizeEntry, extractContent, csvEscape } = require('./fetch-appstore-reviews.js');

// 1) App-info entry (page 1 đầu tiên, KHÔNG có im:rating) -> phải bị bỏ
const appInfoEntry = {
  'im:name': { label: 'MoMo' },
  id: { label: '918751511' },
  'im:image': [{ label: 'http://...' }],
};
assert.strictEqual(normalizeEntry(appInfoEntry, '918751511', 'vn'), null, 'app-info entry phải trả null');

// 2) Review entry bình thường, content là array có block type=text + block html
const reviewEntry = {
  author: { name: { label: 'Nguyễn Văn A' } },
  'im:version': { label: '4.2.25' },
  'im:rating': { label: '5' },
  id: { label: '11112222' },
  title: { label: 'App tốt' },
  content: [
    { label: 'Nội dung text thuần', attributes: { type: 'text' } },
    { label: '<b>html</b>', attributes: { type: 'html' } },
  ],
  updated: { label: '2026-06-01T10:00:00-07:00' },
};
const r = normalizeEntry(reviewEntry, '918751511', 'vn');
assert.strictEqual(r.review_id, '11112222');
assert.strictEqual(r.rating, 5);
assert.strictEqual(r.content, 'Nội dung text thuần', 'phải ưu tiên block type=text');
assert.strictEqual(r.author, 'Nguyễn Văn A');
assert.strictEqual(r.app_version, '4.2.25');

// 3) content là object (không phải array)
assert.strictEqual(extractContent({ label: 'một dòng' }), 'một dòng');

// 4) Surrogate key khi thiếu id -> không được rỗng
const noId = { ...reviewEntry, id: undefined };
const r2 = normalizeEntry(noId, '918751511', 'vn');
assert.ok(r2.review_id && r2.review_id.length > 0, 'phải có surrogate review_id');

// 5) CSV escape: dấu phẩy, xuống dòng, dấu ngoặc kép
assert.strictEqual(csvEscape('a,b'), '"a,b"');
assert.strictEqual(csvEscape('dòng1\ndòng2'), '"dòng1\ndòng2"');
assert.strictEqual(csvEscape('he said "hi"'), '"he said ""hi"""');
assert.strictEqual(csvEscape('binhthuong'), 'binhthuong');
assert.strictEqual(csvEscape(null), '');

console.log('ALL TESTS PASSED ✓');
