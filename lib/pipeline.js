'use strict';
// Dự án (project), hàng đợi tác vụ, bước tạo giọng (genmax) và bước dựng video (FFmpeg).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { Genmax, audioUrlOf, srtOf } = require('./genmax');
const S = require('./srt');
const FF = require('./ffmpeg');
const FX = require('./effects');

const ID_RE = /^[a-f0-9]{12}$/;
const IMG_RE = /^img_[\w.\-]+$/;
const BGM_RE = /^bgm_[\w.\-]+$/;
const MAX_CHARS_PER_REQUEST = 4500; // dưới giới hạn mỗi lần gửi của mọi model genmax

const cache = new Map();
const lastSave = new Map();
const controllers = new Map();
let queue = Promise.resolve();

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const pdir = (id) => {
  if (!ID_RE.test(String(id))) throw httpError(404, 'Dự án không tồn tại');
  return path.join(cfg.PROJECTS, id);
};

// ---------- lưu trữ ----------
function persist(p, force = true) {
  const now = Date.now();
  if (!force && now - (lastSave.get(p.id) || 0) < 400) return;
  lastSave.set(p.id, now);
  p.updatedAt = new Date().toISOString();
  const file = path.join(pdir(p.id), 'project.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
  fs.renameSync(tmp, file);
}

function load(id) {
  if (cache.has(id)) return cache.get(id);
  const dir = pdir(id);
  let p;
  try {
    p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  } catch (_) {
    throw httpError(404, 'Dự án không tồn tại');
  }
  cache.set(id, p);
  return p;
}

function create() {
  const id = crypto.randomBytes(6).toString('hex');
  fs.mkdirSync(path.join(pdir(id), 'images'), { recursive: true });
  const p = {
    id,
    title: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'idle',
    job: null,
    progress: 0,
    message: '',
    error: '',
    logs: [],
    script: '',
    options: normalizeOptions({}),
    images: [],
    imageNames: {},
    imageFx: {}, // hiệu ứng phủ theo từng ảnh: { [file]: { effects, fire, ai } }
    bgm: null,
    voiceHash: '',
    files: { audio: false, srt: false, video: false },
    srtSource: '',
    audioDuration: 0,
    videoDuration: 0,
    stats: { characters: 0 },
  };
  cache.set(id, p);
  persist(p);
  return p;
}

function list() {
  const out = [];
  for (const id of fs.readdirSync(cfg.PROJECTS)) {
    if (!ID_RE.test(id)) continue;
    try {
      out.push(summary(load(id)));
    } catch (_) {}
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

function summary(p) {
  return {
    id: p.id,
    title: p.title || p.script.slice(0, 60) || 'Dự án chưa đặt tên',
    status: p.status,
    job: p.job,
    progress: p.progress,
    updatedAt: p.updatedAt,
    createdAt: p.createdAt,
    orientation: p.options.orientation,
    resolution: p.options.resolution,
    thumb: p.images[0] ? `/files/${p.id}/images/${p.images[0]}` : null,
    hasAudio: p.files.audio,
    hasVideo: p.files.video,
    audioDuration: p.audioDuration,
    videoDuration: p.videoDuration,
  };
}

function publicProject(p) {
  const base = `/files/${p.id}`;
  return {
    ...p,
    imageList: p.images.map((f) => ({ file: f, name: p.imageNames[f] || f, url: `${base}/images/${f}`, fx: p.imageFx?.[f] || null })),
    audioUrl: p.files.audio ? `${base}/voice.mp3?v=${encodeURIComponent(p.voiceHash)}` : null,
    srtUrl: p.files.srt ? `${base}/voice.srt?v=${encodeURIComponent(p.voiceHash)}` : null,
    videoUrl: p.files.video ? `${base}/output.mp4?v=${encodeURIComponent(p.updatedAt)}` : null,
    bgmUrl: p.bgm ? `${base}/${p.bgm}` : null,
  };
}

function remove(id) {
  const dir = pdir(id);
  controllers.get(id)?.abort();
  cache.delete(id);
  lastSave.delete(id);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- tuỳ chọn ----------
const clamp = (v, a, b, d) => {
  v = Number(v);
  return isFinite(v) ? Math.min(b, Math.max(a, v)) : d;
};
const pick = (v, list, d) => (list.includes(v) ? v : d);

function normalizeOptions(o = {}) {
  const c = o.captions || {};
  const v = o.voice || {};
  return {
    orientation: pick(o.orientation, ['landscape', 'portrait'], 'landscape'),
    resolution: pick(Number(o.resolution), [480, 720, 1080, 1440], 1080),
    fps: pick(Number(o.fps), [24, 30, 60], 30),
    fit: pick(o.fit, ['blur', 'cover', 'color'], 'blur'),
    bgColor: /^#[0-9a-f]{6}$/i.test(o.bgColor || '') ? o.bgColor : '#ffffff',
    motion: 'none', // ảnh đứng yên: zoom / lia làm người xem nhức mắt nên đã bỏ
    strength: clamp(o.strength, 0.03, 0.3, 0.12),
    transition: pick(o.transition, ['none', 'fade'], 'none'),
    maxScene: clamp(o.maxScene, 3, 20, 8),
    tail: clamp(o.tail, 0, 5, 0.6),
    normalizeAudio: o.normalizeAudio !== false,
    captions: {
      on: c.on !== false,
      preset: pick(c.preset, ['classic', 'bold', 'box'], 'classic'),
      position: pick(c.position, ['bottom', 'middle', 'top'], 'bottom'),
      sizeMul: clamp(c.sizeMul, 0.6, 2, 1),
      uppercase: !!c.uppercase,
      maxChars: clamp(c.maxChars, 20, 120, 56),
    },
    music: { volume: clamp(o.music?.volume, 0, 1, 0.12) },
    voice: {
      provider: pick(v.provider, ['elevenlabs', 'minimax', 'capcut'], 'elevenlabs'),
      modelId: String(v.modelId || '').slice(0, 80),
      voiceId: String(v.voiceId || '').trim().slice(0, 120),
      voiceName: String(v.voiceName || '').slice(0, 120),
      languageCode: String(v.languageCode || 'vi').slice(0, 40),
      speed: clamp(v.speed, 0.5, 2, 1),
      stability: clamp(v.stability, 0, 1, 0.5),
      similarityBoost: clamp(v.similarityBoost, 0, 1, 0.75),
      style: clamp(v.style, 0, 1, 0),
    },
  };
}

function voiceHashOf(script, opts, settings) {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify({ s: script, v: opts.voice, b: settings.baseUrl, t: settings.exportTranscript }))
    .digest('hex')
    .slice(0, 16);
}

// ---------- tài nguyên (ảnh / nhạc nền) ----------
const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'];
const AUDIO_EXT = ['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac'];

function assetTarget(id, kind, origName) {
  const p = load(id);
  const ext = path.extname(String(origName || '')).toLowerCase();
  const ok = kind === 'image' ? IMG_EXT : AUDIO_EXT;
  if (!ok.includes(ext)) throw httpError(400, `Định dạng không hỗ trợ (${ext || 'không có đuôi'}). Cho phép: ${ok.join(' ')}`);
  const file = `${kind === 'image' ? 'img' : 'bgm'}_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}${ext}`;
  const full = kind === 'image' ? path.join(pdir(id), 'images', file) : path.join(pdir(id), file);
  return { file, full, project: p };
}

function registerAsset(id, kind, file, origName) {
  const p = load(id);
  p.imageNames[file] = String(origName || file).slice(0, 120);
  persist(p);
}

// ---------- prompt tạo ảnh từng cảnh (chỉ lưu lại để mở dự án vẫn còn) ----------
function normalizeScenePrompts(sp) {
  if (!sp || typeof sp !== 'object' || !Array.isArray(sp.scenes)) return null;
  const str = (x, n) => String(x ?? '').slice(0, n);
  return {
    script: str(sp.script, 300000),
    tool: str(sp.tool, 20),
    aspect: sp.aspect === '9:16' ? '9:16' : '16:9',
    userStyle: str(sp.userStyle, 400),
    userStyles: (Array.isArray(sp.userStyles) ? sp.userStyles : []).slice(0, 3).map((x) => ({ text: str(x?.text, 400), when: str(x?.when, 200) })),
    count: Math.max(0, Math.min(2000, Number(sp.count) || 0)),
    style: str(sp.style, 900),
    styles: (Array.isArray(sp.styles) ? sp.styles : []).slice(0, 3).map((x) => ({ label: str(x?.label, 400), desc: str(x?.desc, 900), use: str(x?.use, 300) })),
    model: str(sp.model, 80),
    characters: (Array.isArray(sp.characters) ? sp.characters : []).slice(0, 8).map((c) => ({ name: str(c?.name, 60), look: str(c?.look, 400) })),
    texts: (Array.isArray(sp.texts) ? sp.texts : []).slice(0, 2000).map((t) => str(t, 4000)),
    scenes: sp.scenes.slice(0, 2000).map((s) => ({ n: Number(s?.n) || 0, style: Math.max(1, Math.min(3, Number(s?.style) || 1)), title: str(s?.title, 80), prompt: str(s?.prompt, 2400), file: str(s?.file, 120) })),
  };
}

// ---------- áp dữ liệu từ form ----------
function applyData(p, data, settings) {
  if (typeof data.title === 'string') p.title = data.title.slice(0, 120);
  if (typeof data.script === 'string') p.script = data.script.replace(/\r/g, '').trim().slice(0, 300000);
  if (data.options) p.options = normalizeOptions(data.options);
  if (data.scenePrompts !== undefined) p.scenePrompts = normalizeScenePrompts(data.scenePrompts);
  if (Array.isArray(data.images)) {
    const imgs = [];
    for (const f of data.images) {
      if (typeof f !== 'string' || !IMG_RE.test(f)) continue;
      if (fs.existsSync(path.join(pdir(p.id), 'images', f))) imgs.push(f);
    }
    p.images = imgs;
    // bảng xếp ảnh theo kịch bản: { n: số đoạn, assign: [file cho từng đoạn] }; null = bỏ, chia đều như cũ
    if (data.storyboard === null) p.storyboard = null;
    else if (data.storyboard && Array.isArray(data.storyboard.assign)) {
      const assign = data.storyboard.assign.slice(0, 2000).map((f) => (typeof f === 'string' && imgs.includes(f) ? f : null));
      p.storyboard = assign.some(Boolean) ? { n: assign.length, assign } : null;
    }
    if (data.imageFx && typeof data.imageFx === 'object') {
      p.imageFx = {};
      for (const f of imgs) {
        const fx = FX.normalizeFx(data.imageFx[f]);
        if (fx) p.imageFx[f] = fx;
      }
    }
    for (const f of fs.readdirSync(path.join(pdir(p.id), 'images'))) {
      if (!imgs.includes(f)) {
        try {
          fs.unlinkSync(path.join(pdir(p.id), 'images', f));
        } catch (_) {}
        delete p.imageNames[f];
      }
    }
  }
  if (data.bgm !== undefined) {
    const f = typeof data.bgm === 'string' && BGM_RE.test(data.bgm) && fs.existsSync(path.join(pdir(p.id), data.bgm)) ? data.bgm : null;
    if (p.bgm && p.bgm !== f) {
      try {
        fs.unlinkSync(path.join(pdir(p.id), p.bgm));
      } catch (_) {}
    }
    p.bgm = f;
  }
  // kịch bản / giọng đổi -> giọng cũ không còn dùng được
  const h = voiceHashOf(p.script, p.options, settings);
  if (p.voiceHash && p.voiceHash !== h) {
    for (const f of ['voice.mp3', 'voice.srt']) {
      try {
        fs.unlinkSync(path.join(pdir(p.id), f));
      } catch (_) {}
    }
    p.files.audio = false;
    p.files.srt = false;
    p.voiceHash = '';
    p.audioDuration = 0;
  }
  persist(p);
  return h;
}

// ---------- log / tiến độ ----------
function log(p, msg) {
  p.logs.push({ t: new Date().toISOString().slice(11, 19), msg });
  if (p.logs.length > 300) p.logs.splice(0, p.logs.length - 300);
  persist(p, false);
}
function progress(p, pct, msg) {
  p.progress = Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
  if (msg) p.message = msg;
  persist(p, false);
}

// ---------- bước 1: giọng đọc + SRT ----------
async function runVoice(p, settings, signal, range = [0, 100]) {
  const o = p.options;
  const dir = pdir(p.id);
  const work = path.join(dir, 'work');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const [lo, hi] = range;
  const at = (f) => lo + (hi - lo) * f;

  if (!p.script) throw new Error('Chưa có kịch bản.');
  if (!o.voice.voiceId) throw new Error('Chưa chọn giọng (voice ID). Hãy chọn giọng ở mục Giọng đọc.');
  const client = new Genmax(settings);
  const chunks = S.chunkText(p.script, MAX_CHARS_PER_REQUEST);
  log(p, `Kịch bản ${p.script.length} ký tự -> ${chunks.length} đoạn gửi genmax (${o.voice.provider}).`);

  const voiceSettings =
    o.voice.provider === 'elevenlabs'
      ? { stability: o.voice.stability, similarity_boost: o.voice.similarityBoost, style: o.voice.style, speed: Math.min(1.2, Math.max(0.7, o.voice.speed)), use_speaker_boost: true }
      : o.voice.provider === 'minimax'
        ? { speed: o.voice.speed, pitch: 0, vol: 1 }
        : { speed: o.voice.speed, pitch: 0 };

  const parts = [];
  let cues = [];
  let offset = 0;
  let allFromGenmax = true;
  for (let i = 0; i < chunks.length; i++) {
    const text = chunks[i];
    p.message = `Đang tạo giọng ${i + 1}/${chunks.length}…`;
    const id = await client.createTts(
      {
        text,
        voiceId: o.voice.voiceId,
        provider: o.voice.provider,
        modelId: o.voice.modelId,
        languageCode: o.voice.languageCode,
        voiceSettings,
        exportTranscript: settings.exportTranscript !== false,
      },
      signal,
    );
    log(p, `Đoạn ${i + 1}: task genmax ${id}`);
    const task = await client.waitForTask(id, {
      signal,
      onProgress: (t) => progress(p, at((i + Math.min(1, (Number(t.progress) || 0) / 100) * 0.9) / chunks.length * 0.85), `Đang tạo giọng ${i + 1}/${chunks.length}… ${t.progress ? Math.round(t.progress) + '%' : ''}`),
    });
    const au = audioUrlOf(task);
    if (!au) throw new Error('genmax đã xong nhưng không có audio_url trong kết quả.');
    const buf = await client.download(au, signal);
    const partFile = path.join(work, `voice_${i}.mp3`);
    fs.writeFileSync(partFile, buf);
    const dur = await FF.probeDuration(settings.ffprobePath, partFile);

    let c = [];
    const sr = srtOf(task);
    try {
      if (sr?.text) c = S.parseSrt(sr.text);
      else if (sr?.url) c = S.parseSrt((await client.download(sr.url, signal)).toString('utf8'));
    } catch (e) {
      log(p, `Không tải được SRT từ genmax (${e.message}), dùng SRT tự chia theo câu.`);
    }
    const covered = c.reduce((a, x) => a + x.text.length, 0);
    const bad = !c.length || covered < text.length * 0.4 || Math.max(...c.map((x) => x.end)) > dur + 5;
    if (bad) {
      if (c.length) log(p, `SRT của genmax cho đoạn ${i + 1} không khớp, dùng SRT tự chia.`);
      c = S.fallbackCues(text, dur);
      allFromGenmax = false;
    }
    cues = cues.concat(S.shiftCues(c, offset));
    offset += dur;
    parts.push(partFile);
    p.stats.characters = (p.stats.characters || 0) + text.length;
    progress(p, at(((i + 1) / chunks.length) * 0.9));
  }

  const outAudio = path.join(dir, 'voice.mp3');
  if (parts.length === 1) fs.copyFileSync(parts[0], outAudio);
  else {
    const list = path.join(work, 'list.txt');
    fs.writeFileSync(list, parts.map((f) => `file '${path.basename(f)}'`).join('\n'));
    await FF.run(settings.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'libmp3lame', '-b:a', '192k', outAudio], { signal });
  }
  p.audioDuration = await FF.probeDuration(settings.ffprobePath, outAudio);
  const finalCues = S.normalizeCues(cues, o.captions.maxChars);
  fs.writeFileSync(path.join(dir, 'voice.srt'), S.buildSrt(finalCues));
  p.files.audio = true;
  p.files.srt = true;
  p.srtSource = allFromGenmax ? 'genmax' : 'tự chia theo câu';
  p.voiceHash = voiceHashOf(p.script, p.options, settings);
  fs.rmSync(work, { recursive: true, force: true });
  log(p, `Xong giọng đọc: ${p.audioDuration.toFixed(1)}s, ${finalCues.length} dòng SRT (${p.srtSource}).`);
  progress(p, hi, 'Đã tạo voice + SRT');
}

// ---------- bước 2: dựng video ----------
async function runRender(p, settings, signal, range = [0, 100]) {
  const o = p.options;
  const dir = pdir(p.id);
  const [lo, hi] = range;
  const at = (f) => lo + (hi - lo) * f;
  if (!p.images.length) throw new Error('Chưa có ảnh nào. Hãy tải ít nhất 1 ảnh asset.');
  const audio = path.join(dir, 'voice.mp3');
  const srtFile = path.join(dir, 'voice.srt');
  if (!fs.existsSync(audio)) throw new Error('Chưa có voice-over.');

  const work = path.join(dir, 'work');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  const { w: W, h: H } = FF.resolutionFor(o);
  const fps = o.fps;
  const aDur = await FF.probeDuration(settings.ffprobePath, audio);
  const T = aDur + o.tail;
  const cues = fs.existsSync(srtFile) ? S.normalizeCues(S.parseSrt(fs.readFileSync(srtFile, 'utf8')), o.captions.maxChars) : [];
  // có bảng xếp ảnh theo kịch bản khớp với kịch bản hiện tại -> đổi ảnh đúng đoạn; không thì chia đều theo thứ tự
  let scenes;
  const blocks = p.storyboard ? S.storyBlocks(p.script) : [];
  if (p.storyboard && p.storyboard.n === blocks.length) {
    const segs = [];
    p.storyboard.assign.forEach((f, i) => {
      const file = f && p.images.includes(f) ? f : segs.length ? segs[segs.length - 1].file : p.images[0];
      const last = segs[segs.length - 1];
      if (last && last.file === file) last.b = blocks[i].b;
      else segs.push({ file, a: blocks[i].a, b: blocks[i].b });
    });
    scenes = FF.planStory(T, aDur, cues, segs, blocks[blocks.length - 1].b, o.maxScene);
    log(p, `Xếp ảnh theo kịch bản: ${blocks.length} đoạn -> ${segs.length} cảnh, dùng ${new Set(segs.map((x) => x.file)).size}/${p.images.length} ảnh.`);
  } else {
    if (p.storyboard) log(p, 'Kịch bản đã đổi sau khi xếp ảnh -> bỏ qua bảng xếp, chia đều ảnh theo thứ tự.');
    scenes = FF.planScenes(T, cues, p.images.length, o.maxScene);
  }
  log(p, `Dựng ${W}x${H} @${fps}fps, ${scenes.length} cảnh, dài ${T.toFixed(1)}s.`);

  // ranh giới khung hình tích luỹ -> không bị lệch thời gian
  // kích thước ảnh: cần để đặt hiệu ứng lửa đúng chỗ
  const sizes = {};
  for (const f of new Set(p.images)) {
    if (p.imageFx?.[f]?.effects?.length) sizes[f] = await FF.probeSize(settings.ffprobePath, path.join(dir, 'images', f)).catch(() => null);
  }
  const fxCount = p.images.filter((f) => p.imageFx?.[f]?.effects?.length).length;
  if (fxCount) log(p, `Hiệu ứng phủ trên ${fxCount}/${p.images.length} ảnh.`);

  const fb = scenes.map((s) => Math.round(s.start * fps));
  fb.push(Math.round(T * fps));
  const segs = [];
  for (let i = 0; i < scenes.length; i++) {
    const F = Math.max(1, fb[i + 1] - fb[i]);
    const kind = FF.effectFor(o.motion, i);
    const dur = F / fps;
    const file = scenes[i].file || p.images[scenes[i].img];
    const fx = p.imageFx?.[file] || null;
    const sz = sizes[file];
    const g = FF.sceneFilter({ W, H, fit: o.fit, bgColor: o.bgColor, kind, strength: o.strength, F, fps, fade: o.transition === 'fade', dur, fx, imgW: sz?.w, imgH: sz?.h });
    const out = path.join(work, `seg_${String(i).padStart(3, '0')}.mp4`);
    const img = path.join(dir, 'images', file);
    p.message = `Dựng cảnh ${i + 1}/${scenes.length}…`;
    await FF.run(
      settings.ffmpegPath,
      ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-i', img, '-filter_complex', g, '-frames:v', String(F), '-r', String(fps), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-an', out],
      { signal, onTime: (t) => progress(p, at(((i + Math.min(1, t / dur)) / scenes.length) * 0.82)) },
    );
    segs.push(out);
    progress(p, at(((i + 1) / scenes.length) * 0.82), `Dựng cảnh ${i + 1}/${scenes.length}`);
  }

  p.message = 'Ghép cảnh…';
  fs.writeFileSync(path.join(work, 'list.txt'), segs.map((f) => `file '${path.basename(f)}'`).join('\n'));
  const joined = path.join(work, 'joined.mp4');
  await FF.run(settings.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(work, 'list.txt'), '-c', 'copy', joined], { signal });
  progress(p, at(0.86));

  // ghép cuối: phụ đề + giọng + nhạc nền
  const useCaps = o.captions.on && cues.length;
  const bgm = p.bgm ? path.join(dir, p.bgm) : null;
  const inputs = ['-i', joined, '-i', audio];
  if (bgm) inputs.push('-stream_loop', '-1', '-i', bgm);
  let voiceChain = '[1:a]';
  voiceChain += o.normalizeAudio ? 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,apad' : 'aresample=48000,apad';
  let fc = `${voiceChain}[voc]`;
  if (bgm) fc += `;[2:a]volume=${o.music.volume.toFixed(3)},aresample=48000,afade=t=out:st=${Math.max(0, T - 2).toFixed(2)}:d=2[bg];[voc][bg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`;
  else fc = fc.replace('[voc]', '[a]');
  if (useCaps) {
    fs.writeFileSync(
      path.join(work, 'subs.ass'),
      S.toAss(cues, { w: W, h: H, font: settings.subtitleFont || 'Arial', sizeMul: o.captions.sizeMul, preset: o.captions.preset, position: o.captions.position, uppercase: o.captions.uppercase }),
    );
    fc = `[0:v]ass=subs.ass[v];` + fc;
  }
  const final = path.join(work, 'final.mp4');
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', ...inputs, '-filter_complex', fc, '-map', useCaps ? '[v]' : '0:v', '-map', '[a]'];
  if (useCaps) args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
  else args.push('-c:v', 'copy');
  args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', T.toFixed(3), '-movflags', '+faststart', final);
  p.message = useCaps ? 'Ghép giọng + phụ đề…' : 'Ghép giọng…';
  await FF.run(settings.ffmpegPath, args, { cwd: work, signal, onTime: (t) => progress(p, at(0.86 + Math.min(1, t / T) * 0.14)) });

  const out = path.join(dir, 'output.mp4');
  fs.renameSync(final, out);
  p.videoDuration = await FF.probeDuration(settings.ffprobePath, out);
  p.files.video = true;
  fs.rmSync(work, { recursive: true, force: true });
  log(p, `Xong video ${p.videoDuration.toFixed(1)}s (${(fs.statSync(out).size / 1048576).toFixed(1)} MB).`);
  progress(p, hi, 'Đã tạo video');
}

// ---------- hàng đợi ----------
function start(id, action, data) {
  const p = load(id);
  if (p.status === 'queued' || p.status === 'running') throw httpError(409, 'Dự án đang chạy, hãy chờ hoặc huỷ trước.');
  const settings = cfg.getSettings();
  if (!['voice', 'video'].includes(action)) throw httpError(400, 'action không hợp lệ');
  if (data) applyData(p, data, settings);
  if (!p.script) throw httpError(400, 'Hãy dán kịch bản trước.');
  if (!settings.apiKey && !(action === 'video' && voiceReady(p, settings))) throw httpError(400, 'Chưa có API key genmax.io — vào Settings để nhập.');
  if (action === 'video' && !p.images.length) throw httpError(400, 'Hãy tải ít nhất 1 ảnh asset để dựng video.');
  if (!p.options.voice.voiceId && !voiceReady(p, settings)) throw httpError(400, 'Chưa chọn giọng đọc (voice ID).');

  p.status = 'queued';
  p.job = action;
  p.error = '';
  p.progress = 0;
  p.startedAt = null;
  p.finishedAt = null;
  p.message = 'Đang chờ trong hàng đợi…';
  persist(p);
  const ac = new AbortController();
  controllers.set(id, ac);

  queue = queue.then(async () => {
    if (ac.signal.aborted) return;
    p.status = 'running';
    p.startedAt = new Date().toISOString();
    p.finishedAt = null;
    persist(p);
    try {
      const st = cfg.getSettings();
      if (action === 'voice') await runVoice(p, st, ac.signal, [0, 100]);
      else {
        const need = !voiceReady(p, st);
        if (need) await runVoice(p, st, ac.signal, [0, 30]);
        if (p.files.video) {
          try {
            fs.unlinkSync(path.join(pdir(id), 'output.mp4'));
          } catch (_) {}
          p.files.video = false;
        }
        await runRender(p, st, ac.signal, [need ? 30 : 0, 100]);
      }
      p.status = 'done';
      p.progress = 100;
    } catch (e) {
      if (ac.signal.aborted || e.message === 'Đã huỷ') {
        p.status = 'canceled';
        p.message = 'Đã huỷ';
      } else {
        p.status = 'error';
        p.error = e.message;
        log(p, 'Lỗi: ' + e.message);
      }
    } finally {
      controllers.delete(id);
      p.finishedAt = new Date().toISOString();
      fs.rmSync(path.join(pdir(id), 'work'), { recursive: true, force: true });
      persist(p);
    }
  });
  return p;
}

function voiceReady(p, settings) {
  return p.files.audio && p.voiceHash === voiceHashOf(p.script, p.options, settings) && fs.existsSync(path.join(pdir(p.id), 'voice.mp3'));
}

function cancel(id) {
  const p = load(id);
  const c = controllers.get(id);
  if (c) c.abort();
  if (p.status === 'queued') {
    p.status = 'canceled';
    p.message = 'Đã huỷ';
    persist(p);
  }
  return p;
}

// Khi server khởi động lại: tác vụ dở dang coi như lỗi.
for (const id of fs.readdirSync(cfg.PROJECTS)) {
  if (!ID_RE.test(id)) continue;
  try {
    const p = load(id);
    if (p.status === 'queued' || p.status === 'running') {
      p.status = 'error';
      p.error = 'Server đã khởi động lại giữa chừng, hãy chạy lại.';
      persist(p);
    }
    fs.rmSync(path.join(pdir(id), 'work'), { recursive: true, force: true });
  } catch (_) {}
}

module.exports = { create, load, list, remove, publicProject, applyData, start, cancel, assetTarget, registerAsset, httpError, pdir, ID_RE, normalizeOptions };
