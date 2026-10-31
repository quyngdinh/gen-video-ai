'use strict';
// Dò nhịp bài hát (BPM + vị trí từng phách) để cắt cảnh đúng nhịp.
// Năng lượng theo khung -> đường "onset" (chỗ âm lượng bật lên) -> tự tương quan tìm chu kỳ -> dò pha.
const { spawn } = require('child_process');

const SR = 11025;
const HOP = 256; // ~23ms
const WIN = 512;

/** Giải mã bài hát thành mẫu mono float32 ở SR Hz. */
function decode(ffmpeg, file, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('Đã huỷ'));
      if (code !== 0) return reject(new Error('Không giải mã được bài hát: ' + err.trim().split('\n').pop()));
      const buf = Buffer.concat(chunks);
      const ab = new ArrayBuffer(buf.length - (buf.length % 4));
      new Uint8Array(ab).set(buf.subarray(0, ab.byteLength));
      resolve(new Float32Array(ab));
    });
  });
}

/** Giá trị nội suy tuyến tính của mảng a tại vị trí thực x. */
const at = (a, x) => {
  const i = Math.floor(x);
  if (i < 0 || i + 1 >= a.length) return 0;
  return a[i] + (a[i + 1] - a[i]) * (x - i);
};

/** Phân tích mẫu âm thanh -> { bpm, beats: [giây], bars: [giây phách đầu ô nhịp], confidence }. */
function analyze(x) {
  const n = Math.floor((x.length - WIN) / HOP);
  if (n < 200) return { bpm: 0, beats: [], bars: [], confidence: 0 };
  // năng lượng (đã nhấn tần cao để bắt tiếng trống / vỗ tay) theo khung, thang log
  const le = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let e = 0;
    for (let i = k * HOP + 1, z = k * HOP + WIN; i < z; i++) {
      const v = x[i] - 0.97 * x[i - 1];
      e += v * v;
    }
    le[k] = Math.log(1e-9 + e);
  }
  // onset = phần tăng của năng lượng, trừ trung bình cục bộ (~0.5s)
  const raw = new Float32Array(n);
  for (let k = 1; k < n; k++) raw[k] = Math.max(0, le[k] - le[k - 1]);
  const half = Math.round((0.25 * SR) / HOP);
  const on = new Float32Array(n);
  let acc = 0;
  for (let k = 0; k < Math.min(n, half); k++) acc += raw[k];
  for (let k = 0; k < n; k++) {
    if (k + half < n) acc += raw[k + half];
    if (k - half - 1 >= 0) acc -= raw[k - half - 1];
    const cnt = Math.min(n - 1, k + half) - Math.max(0, k - half) + 1;
    on[k] = Math.max(0, raw[k] - acc / cnt);
  }

  // chu kỳ: tự tương quan cho 60–200 BPM, ưu tiên quanh 115 BPM (nhạc thiếu nhi thường 90–140)
  const fps = SR / HOP;
  let best = { bpm: 0, score: -1 };
  let total = 0;
  const scores = [];
  for (let bpm = 60; bpm <= 200; bpm += 0.5) {
    const lag = (60 * fps) / bpm;
    let s = 0;
    for (let k = 0; k + lag + 1 < n; k++) s += on[k] * at(on, k + lag);
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.9, 2));
    const sc = s * w;
    scores.push(sc);
    total += sc;
    if (sc > best.score) best = { bpm, score: sc };
  }
  // tinh chỉnh: quanh BPM thô, so khớp nhiều chu kỳ liền nhau (1..8 phách) -> sai số nhỏ, lưới phách không trôi
  let fine = best.bpm;
  let fineScore = -1;
  for (let bpm = best.bpm - 3; bpm <= best.bpm + 3; bpm += 0.05) {
    const lag = (60 * fps) / bpm;
    let s = 0;
    for (let m = 1; m <= 8; m++) for (let k = 0; k + m * lag + 1 < n; k += 1) s += on[k] * at(on, k + m * lag);
    if (s > fineScore) {
      fineScore = s;
      fine = bpm;
    }
  }
  best.bpm = Math.round(fine * 10) / 10;
  const P = (60 * fps) / fine;
  // pha: vị trí đặt lưới phách khớp onset nhiều nhất
  let phi = 0;
  let bestPh = -1;
  for (let p = 0; p < P; p += 0.5) {
    let s = 0;
    for (let q = p; q < n; q += P) s += at(on, q) + 0.5 * (at(on, q - 1) + at(on, q + 1));
    if (s > bestPh) {
      bestPh = s;
      phi = p;
    }
  }
  const beatsF = [];
  for (let q = phi; q < n; q += P) beatsF.push(q);
  // phách đầu ô nhịp (giả định 4/4): nhóm có tổng onset lớn nhất
  let down = 0;
  let bestD = -1;
  for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let j = r; j < beatsF.length; j += 4) s += at(on, beatsF[j]);
    if (s > bestD) {
      bestD = s;
      down = r;
    }
  }
  const t = (f) => Math.round(((f * HOP + WIN / 2) / SR) * 1000) / 1000;
  const mean = total / scores.length || 1;
  return {
    bpm: best.bpm,
    beats: beatsF.map(t),
    bars: beatsF.filter((_, j) => j % 4 === down).map(t),
    confidence: Math.round(Math.min(1, (best.score / mean - 1) / 2) * 100) / 100,
  };
}

async function detect(ffmpeg, file, signal) {
  return analyze(await decode(ffmpeg, file, signal));
}

/** Phách gần t nhất trong khoảng ±tol giây (không có thì trả t). */
function snap(beats, t, tol) {
  let lo = 0;
  let hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  let best = t;
  let bd = tol;
  for (const b of [beats[lo - 1], beats[lo]]) {
    if (b !== undefined && Math.abs(b - t) <= bd) {
      bd = Math.abs(b - t);
      best = b;
    }
  }
  return best;
}

/** Phách cuối cùng nằm trong (a, z]; không có thì null. */
function lastBeatIn(beats, a, z) {
  let r = null;
  for (const b of beats) {
    if (b > z) break;
    if (b > a) r = b;
  }
  return r;
}

module.exports = { detect, analyze, snap, lastBeatIn };
