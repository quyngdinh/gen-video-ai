'use strict';
// Bọc FFmpeg: chạy lệnh, đọc tiến độ, dựng cảnh (zoom/pan trên ảnh tĩnh), ghép cuối.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const FX = require('./effects');

/** Chạy một tiến trình; onTime(giây) được gọi khi ffmpeg báo tiến độ. */
function run(bin, args, { cwd, onTime, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Đã huỷ'));
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let buf = '';
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      if (out.length > 200000) out = out.slice(-100000);
      if (onTime) {
        buf += s;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
          if (m) onTime(Number(m[1]) / 1e6);
        }
      }
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 20000) err = err.slice(-10000);
    });
    child.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      if (e.code === 'ENOENT') reject(new Error(`Không tìm thấy "${bin}". Hãy cài FFmpeg (brew install ffmpeg) hoặc chỉnh đường dẫn trong Settings.`));
      else reject(e);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('Đã huỷ'));
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${path.basename(bin)} lỗi (mã ${code}): ${err.trim().split('\n').slice(-6).join('\n')}`));
    });
  });
}

async function probeDuration(ffprobe, file) {
  const { out } = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const d = parseFloat(out.trim());
  if (!isFinite(d) || d <= 0) throw new Error('Không đọc được độ dài file: ' + path.basename(file));
  return d;
}

/** Kích thước ảnh (px). */
async function probeSize(ffprobe, file) {
  const { out } = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file]);
  const [w, h] = out.trim().split('\n')[0].split('x').map(Number);
  if (!(w > 0 && h > 0)) throw new Error('Không đọc được kích thước ảnh: ' + path.basename(file));
  return { w, h };
}

async function check(settings) {
  const res = { ok: false, version: '', libass: false, zoompan: false, error: '' };
  try {
    const v = await run(settings.ffmpegPath, ['-hide_banner', '-version']);
    res.version = (v.out.split('\n')[0] || '').trim();
    const f = await run(settings.ffmpegPath, ['-hide_banner', '-filters']);
    res.libass = /\bass\b/.test(f.out) && /\bsubtitles\b/.test(f.out);
    res.zoompan = /\bzoompan\b/.test(f.out);
    await run(settings.ffprobePath, ['-hide_banner', '-version']);
    res.ok = res.zoompan;
  } catch (e) {
    res.error = e.message;
  }
  return res;
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function resolutionFor(o) {
  const short = Number(o.resolution) || 1080;
  const long = even((short * 16) / 9);
  return o.orientation === 'portrait' ? { w: even(short), h: long } : { w: long, h: even(short) };
}

/** Biểu thức zoompan cho từng kiểu chuyển động. F = số khung hình của cảnh. */
function motionExpr(kind, F, s) {
  const p = `on/${Math.max(F - 1, 1)}`;
  const cx = 'iw/2-(iw/zoom/2)';
  const cy = 'ih/2-(ih/zoom/2)';
  switch (kind) {
    case 'zoomIn':
      return { z: `1+${s}*${p}`, x: cx, y: cy };
    case 'zoomOut':
      return { z: `${1 + s}-${s}*${p}`, x: cx, y: cy };
    case 'panLeft':
      return { z: `${1 + s}`, x: `(iw-iw/zoom)*(1-${p})`, y: cy };
    case 'panRight':
      return { z: `${1 + s}`, x: `(iw-iw/zoom)*${p}`, y: cy };
    case 'panUp':
      return { z: `${1 + s}`, x: cx, y: `(ih-ih/zoom)*(1-${p})` };
    case 'panDown':
      return { z: `${1 + s}`, x: cx, y: `(ih-ih/zoom)*${p}` };
    default:
      return { z: '1', x: '0', y: '0' };
  }
}

/**
 * Toạ độ trên khung hình (biểu thức theo t) của một điểm trên ảnh gốc (nx, ny: 0..1),
 * bám theo cách đặt ảnh (fit) và chuyển động zoompan của cảnh.
 */
function pointExpr({ nx, ny, imgW, imgH, W, H, PW, PH, fit, kind, F, fps, s }) {
  const k = fit === 'cover' ? Math.max(PW / imgW, PH / imgH) : Math.min(PW / imgW, PH / imgH);
  const cx = (PW - imgW * k) / 2 + nx * imgW * k;
  const cy = (PH - imgH * k) / 2 + ny * imgH * k;
  const p = `min(1,t*${fps}/${Math.max(F - 1, 1)})`;
  let z = '1';
  if (kind === 'zoomIn') z = `(1+${s}*${p})`;
  else if (kind === 'zoomOut') z = `(${1 + s}-${s}*${p})`;
  else if (kind !== 'none') z = `${1 + s}`;
  const midX = `(${PW}/2-${PW}/(2*${z}))`;
  const midY = `(${PH}/2-${PH}/(2*${z}))`;
  let x0 = midX;
  let y0 = midY;
  if (kind === 'panLeft') x0 = `(${PW}-${PW}/${z})*(1-${p})`;
  if (kind === 'panRight') x0 = `(${PW}-${PW}/${z})*${p}`;
  if (kind === 'panUp') y0 = `(${PH}-${PH}/${z})*(1-${p})`;
  if (kind === 'panDown') y0 = `(${PH}-${PH}/${z})*${p}`;
  if (kind === 'none') x0 = y0 = '0';
  return {
    X: `(${cx.toFixed(1)}-${x0})*${z}*${(W / PW).toFixed(5)}`,
    Y: `(${cy.toFixed(1)}-${y0})*${z}*${(H / PH).toFixed(5)}`,
  };
}

function effectFor(motion, i) {
  if (motion === 'none') return 'none';
  if (motion === 'zoom') return i % 2 === 0 ? 'zoomIn' : 'zoomOut';
  const cycle = ['zoomIn', 'panRight', 'zoomOut', 'panLeft', 'zoomIn', 'panDown', 'zoomOut', 'panUp'];
  return cycle[i % cycle.length];
}

function colorHex(c) {
  return /^#[0-9a-f]{6}$/i.test(c || '') ? '0x' + c.slice(1) : '0xffffff';
}

/** Dựng filtergraph cho một cảnh. */
function sceneFilter({ W, H, fit, bgColor, kind, strength, F, fps, fade, dur, fx, imgW, imgH }) {
  const f = kind === 'none' ? 1 : 1.5;
  const PW = even(W * f);
  const PH = even(H * f);
  const m = motionExpr(kind, F, strength);
  const zp = `zoompan=z='${m.z}':x='${m.x}':y='${m.y}':d=${F}:s=${W}x${H}:fps=${fps}`;
  let g;
  if (fit === 'cover') {
    g = `[0:v]scale=${PW}:${PH}:force_original_aspect_ratio=increase,crop=${PW}:${PH},setsar=1,${zp}`;
  } else if (fit === 'color') {
    g =
      `color=c=${colorHex(bgColor)}:s=${PW}x${PH}:r=1[bg];` +
      `[0:v]format=rgba,scale=${PW}:${PH}:force_original_aspect_ratio=decrease[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto:shortest=1,setsar=1,${zp}`;
  } else {
    // mặc định: ảnh nằm trọn khung, nền là chính ảnh đó làm mờ
    g =
      `[0:v]split=2[a][b];` +
      `[a]scale=${PW}:${PH}:force_original_aspect_ratio=increase,crop=${PW}:${PH},scale=iw/12:ih/12,boxblur=5:2,scale=${PW}:${PH},eq=brightness=-0.08[bg];` +
      `[b]format=rgba,scale=${PW}:${PH}:force_original_aspect_ratio=decrease[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto,setsar=1,${zp}`;
  }
  const effects = fx?.effects || [];
  if (effects.length) {
    const fires = effects.includes('fire') && imgW ? (fx.fire || []).map((pt) => pointExpr({ nx: pt.x, ny: pt.y, imgW, imgH, W, H, PW, PH, fit, kind, F, fps, s: strength })) : [];
    const c = FX.effectChain({ W, H, fps, effects, fires, inLabel: 'zb', outLabel: 'zo' });
    g += `[zb];${c.graph};[zo]`;
    g += 'format=yuv420p';
  } else g += ',format=yuv420p';
  if (fade && dur > 1) g += `,fade=t=in:st=0:d=0.2,fade=t=out:st=${(dur - 0.2).toFixed(3)}:d=0.2`;
  return g;
}

/**
 * Chia thời lượng cho từng ảnh, ngắt cảnh trùng với ranh giới câu thoại.
 * Trả về [{img, start, end}], liên tục từ 0 tới T.
 */
function planScenes(T, cues, nImages, maxScene, minScene = 1.5) {
  const use = Math.max(1, Math.min(nImages, Math.floor(T / minScene)));
  const cands = [];
  for (const c of cues) cands.push(c.start, c.end);
  const snap = (b, tol) => {
    let best = null;
    let bd = Infinity;
    for (const t of cands) {
      const d = Math.abs(t - b);
      if (t > 0 && t < T && d < bd) {
        bd = d;
        best = t;
      }
    }
    return best !== null && bd <= tol ? best : b;
  };
  const bounds = [0];
  const slot = T / use;
  for (let i = 1; i < use; i++) {
    let b = snap(i * slot, slot * 0.4);
    b = Math.max(b, bounds[bounds.length - 1] + minScene);
    b = Math.min(b, T - minScene * (use - i));
    bounds.push(b);
  }
  bounds.push(T);
  const scenes = [];
  for (let i = 0; i < use; i++) {
    const a = bounds[i];
    const z = bounds[i + 1];
    const parts = Math.max(1, Math.ceil((z - a) / maxScene));
    const edges = [a];
    for (let k = 1; k < parts; k++) {
      let b = snap(a + ((z - a) * k) / parts, ((z - a) / parts) * 0.35);
      b = Math.max(b, edges[edges.length - 1] + 0.8);
      edges.push(Math.min(b, z - 0.8));
    }
    edges.push(z);
    for (let k = 0; k < parts; k++) scenes.push({ img: i, start: edges[k], end: edges[k + 1] });
  }
  return scenes;
}

/**
 * Xếp cảnh theo bảng kịch bản ↔ ảnh.
 * segs: [{ file, a, b }] — a, b là vị trí ký tự trong kịch bản (tổng `total` ký tự).
 * Vị trí ký tự được đổi ra thời điểm theo SRT (mỗi dòng phụ đề chứa bao nhiêu chữ),
 * rồi ranh giới được kéo về đúng chỗ bắt đầu dòng phụ đề gần nhất. Trả về [{ file, start, end }].
 */
function planStory(T, aDur, cues, segs, total, maxScene) {
  const cs = cues.length ? cues : [{ start: 0, end: aDur, text: 'x'.repeat(Math.max(1, total)) }];
  const lens = cs.map((c) => c.text.length + 1);
  const L = lens.reduce((x, y) => x + y, 0);
  const timeAt = (pos) => {
    let q = (pos / Math.max(1, total)) * L;
    for (let k = 0; k < cs.length; k++) {
      if (q <= lens[k]) return cs[k].start + (cs[k].end - cs[k].start) * (q / lens[k]);
      q -= lens[k];
    }
    return cs[cs.length - 1].end;
  };
  const starts = cs.map((c) => c.start);
  const snap = (t, tol) => {
    let best = t;
    let bd = tol;
    for (const x of starts) {
      const d = Math.abs(x - t);
      if (x > 0 && x < T && d <= bd) {
        bd = d;
        best = x;
      }
    }
    return best;
  };
  // ranh giới từng đoạn; đoạn ngắn hơn 1 giây thì gộp vào đoạn trước
  const parts = [];
  for (const sg of segs) {
    const t = parts.length ? snap(timeAt(sg.a), 1.5) : 0;
    const last = parts[parts.length - 1];
    if (last && t - last.start < 1) {
      if (last.file !== sg.file && t - last.start < 0.3) last.file = sg.file;
      continue;
    }
    parts.push({ file: sg.file, start: Math.min(t, T - 0.5) });
  }
  const scenes = [];
  parts.forEach((pt, i) => {
    const a = pt.start;
    const z = i + 1 < parts.length ? parts[i + 1].start : T;
    const n = Math.max(1, Math.ceil((z - a) / maxScene));
    const edges = [a];
    for (let k = 1; k < n; k++) {
      let b = snap(a + ((z - a) * k) / n, ((z - a) / n) * 0.35);
      b = Math.max(b, edges[edges.length - 1] + 0.8);
      edges.push(Math.min(b, z - 0.8));
    }
    edges.push(z);
    for (let k = 0; k < n; k++) scenes.push({ file: pt.file, start: edges[k], end: edges[k + 1] });
  });
  return scenes;
}

module.exports = { run, probeDuration, probeSize, check, planStory, resolutionFor, sceneFilter, effectFor, planScenes, even };
