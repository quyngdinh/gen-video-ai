'use strict';
// Logo kênh: tách nền (ảnh JPG nền trắng / nền màu trơn) -> PNG trong suốt, cắt sát logo.
// Không dùng thư viện ngoài: ffmpeg giải mã ra RGBA thô, xử lý bằng JS, rồi ffmpeg ghi lại PNG.
const fs = require('fs');
const FF = require('./ffmpeg');

const MAX_SIDE = 1600; // logo lớn hơn thì thu nhỏ trước khi xử lý (đủ nét cho video 4K góc màn hình)

async function readRgba(settings, src, tmp) {
  const { w, h } = await FF.probeSize(settings.ffprobePath, src);
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const W = Math.max(1, Math.round(w * k));
  const H = Math.max(1, Math.round(h * k));
  await FF.run(settings.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-frames:v', '1', '-vf', `scale=${W}:${H}:flags=lanczos,format=rgba`, '-f', 'rawvideo', '-pix_fmt', 'rgba', tmp]);
  const buf = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });
  if (buf.length !== W * H * 4) throw new Error('không giải mã được ảnh');
  return { buf, W, H };
}

async function writePng(settings, { buf, W, H }, out, tmp) {
  fs.writeFileSync(tmp, buf);
  try {
    await FF.run(settings.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-i', tmp, '-frames:v', '1', '-pix_fmt', 'rgba', out]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Ảnh đã có nền trong suốt (PNG/WebP có alpha) thì không cần tách nền. */
function hasAlpha(buf) {
  let n = 0;
  for (let i = 3; i < buf.length; i += 4) if (buf[i] < 250) n++;
  return n > buf.length / 4 / 100;
}

/** Màu nền = trung vị các điểm ở mép ảnh. */
function borderColor(buf, W, H) {
  const rs = [], gs = [], bs = [];
  const add = (x, y) => {
    const i = (y * W + x) * 4;
    rs.push(buf[i]), gs.push(buf[i + 1]), bs.push(buf[i + 2]);
  };
  for (let x = 0; x < W; x++) add(x, 0), add(x, H - 1);
  for (let y = 0; y < H; y++) add(0, y), add(W - 1, y);
  const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
  return [med(rs), med(gs), med(bs)];
}

/**
 * Xoá nền: loang từ mép ảnh qua các điểm "giống nền" (gần màu nền, hoặc bóng xám nhạt trên nền trắng).
 * Chỉ vùng nối liền với mép mới bị xoá, nên phần trắng nằm trong logo (viền trắng quanh chữ có nét viền tối bao ngoài) vẫn giữ.
 * Mép logo được làm mềm: điểm sát nền lấy độ trong suốt theo độ khác màu nền và khử viền trắng lem.
 */
function removeBackground(buf, W, H, tol = 1) {
  const bg = borderColor(buf, W, H);
  const bgLum = (bg[0] + bg[1] + bg[2]) / 3;
  const bgChroma = Math.max(...bg) - Math.min(...bg);
  const dist = (i) => Math.max(Math.abs(buf[i] - bg[0]), Math.abs(buf[i + 1] - bg[1]), Math.abs(buf[i + 2] - bg[2]));
  const like = (i) => {
    if (dist(i) < 38 * tol) return true;
    if (bgChroma > 30) return false;
    // bóng đổ trên nền sáng: xám (độ bão hoà thấp), sáng hơn nửa nền — nét viền tối / màu của logo không lọt qua
    const r = buf[i], g = buf[i + 1], b = buf[i + 2];
    const mx = Math.max(r, g, b);
    return mx > 0 && (mx - Math.min(r, g, b)) / mx < 0.17 * tol && (r + g + b) / 3 > bgLum * (1 - 0.5 * tol);
  };
  const N = W * H;
  const bgMask = new Uint8Array(N);
  const stack = [];
  const seed = (p) => {
    if (!bgMask[p] && like(p * 4)) {
      bgMask[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < W; x++) seed(x), seed((H - 1) * W + x);
  for (let y = 0; y < H; y++) seed(y * W), seed(y * W + W - 1);
  while (stack.length) {
    const p = stack.pop();
    const x = p % W;
    if (x > 0) seed(p - 1);
    if (x < W - 1) seed(p + 1);
    if (p >= W) seed(p - W);
    if (p < N - W) seed(p + W);
  }
  for (let p = 0; p < N; p++) if (bgMask[p]) buf[p * 4 + 3] = 0;
  // mép: điểm giữ lại nằm sát nền -> trong suốt một phần + bỏ phần màu nền lem vào
  for (let p = 0; p < N; p++) {
    if (bgMask[p]) continue;
    const x = p % W;
    const edge = (x > 0 && bgMask[p - 1]) || (x < W - 1 && bgMask[p + 1]) || (p >= W && bgMask[p - W]) || (p < N - W && bgMask[p + W]);
    if (!edge) continue;
    const i = p * 4;
    const a = Math.min(1, Math.max(0.25, dist(i) / 110));
    for (let c = 0; c < 3; c++) buf[i + c] = Math.max(0, Math.min(255, Math.round((buf[i + c] - bg[c] * (1 - a)) / a)));
    buf[i + 3] = Math.round(a * 255);
  }
  return bg;
}

/** Cắt sát phần không trong suốt (chừa lề nhỏ). */
function cropToContent(img) {
  const { buf, W, H } = img;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (buf[(y * W + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) throw new Error('ảnh trống sau khi tách nền — hãy tắt "Xoá nền" hoặc dùng PNG nền trong suốt');
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.02);
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(W - 1, x1 + pad);
  y1 = Math.min(H - 1, y1 + pad);
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) buf.copy(out, y * w * 4, ((y + y0) * W + x0) * 4, ((y + y0) * W + x1 + 1) * 4);
  return { buf: out, W: w, H: h };
}

/**
 * src (jpg/png/webp…) -> out (PNG trong suốt, cắt sát). removeBg: tách nền nếu ảnh chưa có nền trong suốt.
 * Trả về { w, h, removed } — removed: đã tách nền thật hay không.
 */
async function processLogo(settings, src, out, { removeBg = true } = {}) {
  const tmp = out + '.rgba';
  const img = await readRgba(settings, src, tmp);
  let removed = false;
  if (removeBg && !hasAlpha(img.buf)) {
    removeBackground(img.buf, img.W, img.H);
    removed = true;
  }
  const c = cropToContent(img);
  await writePng(settings, c, out, tmp);
  return { w: c.W, h: c.H, removed };
}

module.exports = { processLogo, removeBackground, cropToContent, hasAlpha };
