'use strict';
// Logo ngôi sao Gemini (Veo) ở góc dưới phải clip: dò vị trí logo trong từng clip, rồi filter ffmpeg xoá logo.
// Logo là ngôi sao 4 cánh trắng bán trong suốt, đứng yên suốt clip. Gặp 2 kiểu (có clip có cả hai):
//  - ngôi sao lớn: tâm cách mép phải / mép dưới ~0.167·S, cỡ ~0.072·S (S = cạnh ngắn của khung);
//  - ngôi sao nhỏ sát góc: tâm cách mép ~0.067 / 0.075·S, cỡ ~0.03·S.
// Cách dò: lấy nhiều khung hình vùng góc dưới phải, tính độ mạnh cạnh trung bình theo thời gian (cảnh chuyển động
// bị nhoè, logo đứng yên thì vẫn rõ), rồi so khớp đường viền ngôi sao ở mọi vị trí / nhiều cỡ.
// Logo trên nền sáng / sát viền ảnh có khi không dò ra -> vị trí ngôi sao lớn luôn được xoá (dò được thì theo chỗ dò).
const fs = require('fs');
const FF = require('./ffmpeg');

const PAD = 0.01; // lề thêm quanh vùng xoá / cạnh ngắn

// vùng dò: góc dưới phải, tính theo cạnh ngắn S
const REGION = 0.42; // rộng = cao = 0.42·S tính từ góc
const SCALE = 400; // vùng dò thu về SCALE x SCALE px
const SAMPLES = 12;
const SIZES = [0.022, 0.026, 0.03, 0.035, 0.04, 0.046, 0.053, 0.06, 0.067, 0.074, 0.082]; // cỡ logo thử (/ S): có bản logo nhỏ sát góc, có bản lớn
const MIN_SCORE = 2; // điểm khớp tối thiểu ở vị trí hay gặp
const MIN_SCORE_ELSEWHERE = 6; // ở chỗ khác phải khớp rất rõ (tránh nhầm ngôi sao vẽ trong tranh)
// vị trí hay gặp (tâm cách mép phải / mép dưới, cỡ — theo S); MODES[0] luôn được xoá
const MODES = [
  { rx: 0.167, ry: 0.167, size: 0.072 },
  { rx: 0.067, ry: 0.075, size: 0.03 },
];
const NEAR = 0.025; // tâm lệch tối đa so với vị trí hay gặp (/ S)

/** Vị trí ngôi sao lớn thường gặp, dạng mark. */
function defaultMark(W, H) {
  const S = Math.min(W, H);
  const md = MODES[0];
  return { cx: 1 - (md.rx * S) / W, cy: 1 - (md.ry * S) / H, size: md.size };
}

/** Vùng xoá (px) cho một logo trong khung W x H. mark: { cx, cy, size } (cx theo W, cy theo H, size theo S). */
function box(W, H, mark = defaultMark(W, H)) {
  const S = Math.min(W, H);
  const half = (mark.size / 2 + PAD) * S;
  const x = Math.max(1, Math.round(mark.cx * W - half));
  const y = Math.max(1, Math.round(mark.cy * H - half));
  const side = Math.round(half * 2);
  return { x, y, w: Math.min(side, W - x - 1), h: Math.min(side, H - y - 1) };
}

/** Filter xoá logo (nội suy từ viền vùng), đặt ngay sau đầu vào clip gốc (kích thước gốc w x h). marks: từ locate(). */
function filter(w, h, marks) {
  const list = marks?.length ? marks : [defaultMark(w, h)];
  return list
    .map((m) => box(w, h, m))
    .map((b) => `delogo=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}`)
    .join(',');
}

/** Các điểm trên đường viền ngôi sao 4 cánh (astroid |x|^⅔+|y|^⅔=r^⅔), bán kính r px, tâm (0,0). */
function outline(r) {
  const pts = new Map();
  const n = Math.max(64, Math.round(r * 16));
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = Math.round(r * Math.cos(t) ** 3);
    const y = Math.round(r * Math.sin(t) ** 3);
    pts.set(`${x},${y}`, [x, y]);
  }
  return [...pts.values()];
}

/** Điểm nằm hẳn trong lòng ngôi sao (cách viền) — để so: viền phải mạnh hơn lòng. */
function inner(r) {
  const out = [];
  const k = r * 0.55;
  for (let y = -Math.round(k); y <= k; y++)
    for (let x = -Math.round(k); x <= k; x++) if (Math.abs(x) ** (2 / 3) + Math.abs(y) ** (2 / 3) < (k * 0.8) ** (2 / 3)) out.push([x, y]);
  return out;
}

/** Vòng ngoài quanh ngôi sao (hình vuông xoay ôm các mũi nhọn) — cũng phải ít cạnh, để không khớp vào một góc của ngôi sao lớn hơn / nét vẽ. */
function ring(r) {
  const out = [];
  const n = Math.max(48, Math.round(r * 10));
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    // hình thoi bán kính 1.45r: đi qua ngoài các mũi nhọn và chỗ lõm giữa hai mũi
    const c = Math.cos(t), sn = Math.sin(t);
    const k = (1.45 * r) / (Math.abs(c) + Math.abs(sn));
    out.push([Math.round(c * k), Math.round(sn * k)]);
  }
  return out;
}
/** Thu nhỏ bản đồ cạnh f lần (lấy giá trị lớn nhất mỗi ô f x f để không mất nét mảnh). */
function shrink(edge, G, f) {
  if (f === 1) return { e: edge, g: G };
  const g = Math.floor(G / f);
  const e = new Float32Array(g * g);
  for (let y = 0; y < g; y++)
    for (let x = 0; x < g; x++) {
      let v = 0;
      for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) v = Math.max(v, edge[(y * f + j) * G + x * f + i]);
      e[y * g + x] = v;
    }
  return { e, g };
}
const offsets = (pts, g) => Int32Array.from(pts, ([dx, dy]) => dy * g + dx);
const meanAt = (e, p, offs) => {
  let v = 0;
  for (let i = 0; i < offs.length; i++) v += e[p + offs[i]];
  return v / offs.length;
};

/**
 * Dò logo trong clip. Trả về danh sách mark { cx, cy, size, score } (cx theo W, cy theo H, size theo S),
 * luôn có ngôi sao lớn (dò được thì đúng chỗ dò, không thì vị trí thường gặp, score 0). info: { w, h, dur }.
 */
async function locate(settings, file, { w, h, dur }) {
  const S = Math.min(w, h);
  const side = Math.min(Math.round(REGION * S), w, h);
  const x0 = w - side;
  const y0 = h - side;
  const tmp = `${file}.wm.gray`;
  const n = SAMPLES;
  const step = Math.max(0.05, (dur || 1) / (n + 1));
  let buf;
  try {
    await FF.run(settings.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `fps=1/${step.toFixed(3)},crop=${side}:${side}:${x0}:${y0},scale=${SCALE}:${SCALE}:flags=area,format=gray`, '-frames:v', String(n), '-f', 'rawvideo', tmp]);
    buf = fs.readFileSync(tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const G = SCALE;
  const frames = Math.floor(buf.length / (G * G));
  if (!frames) return [defaultMark(w, h)];
  // độ mạnh cạnh trung bình theo thời gian
  const edge = new Float32Array(G * G);
  for (let f = 0; f < frames; f++) {
    const o = f * G * G;
    for (let y = 1; y < G - 1; y++)
      for (let x = 1; x < G - 1; x++) {
        const p = o + y * G + x;
        edge[y * G + x] += Math.hypot(buf[p + 1] - buf[p - 1], buf[p + G] - buf[p - G]) / frames;
      }
  }
  const pxPerS = G / (side / S); // px vùng dò trên 1 đơn vị S
  const levels = new Map();
  const best = new Map(); // nhóm: 0, 1 (gần MODES[i]) / -1 (chỗ khác) -> khớp tốt nhất
  for (const size of SIZES) {
    // mỗi cỡ dò trên bản đồ thu nhỏ sao cho bán kính ngôi sao ~10px: nhanh mà vẫn đủ nét
    const f = Math.max(1, Math.round(((size / 2) * pxPerS) / 10));
    if (!levels.has(f)) levels.set(f, shrink(edge, G, f));
    const { e, g } = levels.get(f);
    const r = ((size / 2) * pxPerS) / f;
    const ol = offsets(outline(r), g);
    const inn = offsets(inner(r), g);
    const rg = offsets(ring(r), g);
    const m = Math.ceil(r * 1.45) + 2;
    for (let cy = m; cy < g - m; cy++)
      for (let cx = m; cx < g - m; cx++) {
        const p = cy * g + cx;
        const on = meanAt(e, p, ol);
        if (on < 4) continue;
        const score = on / (Math.max(meanAt(e, p, inn), meanAt(e, p, rg)) + 2);
        // tâm tính từ góc dưới phải vùng dò = góc dưới phải khung hình
        const rx = (G - (cx + 0.5) * f) / pxPerS;
        const ry = (G - (cy + 0.5) * f) / pxPerS;
        const k = MODES.findIndex((md) => Math.hypot(rx - md.rx, ry - md.ry) < NEAR && Math.abs(size - md.size) / md.size < 0.4);
        const cur = best.get(k);
        if (!cur || score > cur.score) best.set(k, { score, rx, ry, size });
      }
  }
  // minSize: vùng xoá ở vị trí hay gặp không nhỏ hơn cỡ chuẩn (khớp hụt vào một phần ngôi sao vẫn xoá hết)
  const mark = (b, minSize = 0) => ({ cx: 1 - (b.rx * S) / w, cy: 1 - (b.ry * S) / h, size: Math.max(b.size, minSize), score: Math.round(b.score * 100) / 100 });
  const out = [];
  const big = best.get(0);
  out.push(big && big.score >= MIN_SCORE ? mark(big, MODES[0].size) : { ...defaultMark(w, h), score: 0 });
  const small = best.get(1);
  if (small && small.score >= MIN_SCORE) out.push(mark(small, MODES[1].size));
  const other = best.get(-1);
  // chỗ khác: chỉ khi khớp rất rõ và không nằm đè lên logo đã có (khớp vào một góc của ngôi sao lớn)
  if (other && other.score >= MIN_SCORE_ELSEWHERE) {
    const o = mark(other);
    if (!out.some((m) => Math.hypot((m.cx - o.cx) * w, (m.cy - o.cy) * h) < ((m.size + o.size) / 2) * S)) out.push(o);
  }
  return out;
}

module.exports = { box, filter, locate, defaultMark };
