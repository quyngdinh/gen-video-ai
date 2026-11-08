'use strict';
// Video nhạc (thiếu nhi): bài hát có sẵn + lời (LRC / SRT / chấm nhịp) + các clip video ngắn -> video ca nhạc có lời karaoke.
// Cảnh cắt đúng nhịp bài hát; AI có thể xem clip và tự xếp clip theo lời + không khí từng đoạn.
// Tách riêng hoàn toàn khỏi luồng "Tạo video" (kịch bản -> giọng TTS): dữ liệu nằm ở data/music/<id>.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const S = require('./srt');
const FF = require('./ffmpeg');
const Beats = require('./beats');
const Vision = require('./vision');
const Logo = require('./logo');
const Watermark = require('./watermark');

const ROOT = path.join(cfg.DATA, 'music');
fs.mkdirSync(ROOT, { recursive: true });

// id = tên thư mục dự án: slug của tên dự án ("Con cò bé bé" -> con-co-be-be); dự án cũ dùng 12 ký tự hex
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_IDS = ['intro', 'outro', 'logo'];
const isId = (id) => ID_RE.test(String(id)) && String(id).length <= 80 && !RESERVED_IDS.includes(String(id));
const CLIP_RE = /^(clip|img)_[\w.\-]+$/;
const SONG_RE = /^song_[\w.\-]+$/;
const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'];
const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'];
const AUDIO_EXT = ['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac'];
const MAX_LINES = 2000;

// Hiệu ứng thiếu nhi: vẽ bằng phụ đề ASS (hình vector + chuyển động), dựng một lần ở bước ghép cuối nên rất nhẹ.
const KIDS_FX = {
  stars: { label: 'Sao lấp lánh', icon: '⭐' },
  bubbles: { label: 'Bong bóng xà phòng', icon: '🫧' },
  notes: { label: 'Nốt nhạc bay', icon: '🎵' },
  hearts: { label: 'Trái tim', icon: '💖' },
  confetti: { label: 'Kim tuyến rơi', icon: '🎉' },
  balloons: { label: 'Bóng bay', icon: '🎈' },
};
const FX_IDS = Object.keys(KIDS_FX);

// Màu phụ đề karaoke: chữ đã hát / chưa hát / viền (RRGGBB)
const CAPTION_PRESETS = {
  candy: { label: 'Kẹo ngọt', sung: 'FF5FA8', unsung: 'FFFFFF', outline: '6A1B9A' },
  sunny: { label: 'Nắng vàng', sung: 'FFD400', unsung: 'FFFFFF', outline: '1565C0' },
  mint: { label: 'Bạc hà', sung: '3DF59B', unsung: 'FFFFFF', outline: '00695C' },
  classic: { label: 'Cổ điển', sung: 'FFE14D', unsung: 'FFFFFF', outline: '000000' },
  fire: { label: 'Lửa cam', sung: 'FF8A00', unsung: 'FFF6D8', outline: '8A1C00' },
  pop: { label: 'Neon', sung: '00E5FF', unsung: 'FFFFFF', outline: 'C2185B' },
  gold: { label: 'Vàng kim', sung: 'FFC93C', unsung: 'FFFFFF', outline: '7B2D26' },
  berry: { label: 'Dâu tây', sung: 'FF4D6D', unsung: 'FFFFFF', outline: '3A0CA3' },
  magic: { label: 'Phép thuật', sung: 'D9A6FF', unsung: 'FFFFFF', outline: '2E0854' },
  ocean: { label: 'Biển xanh', sung: '4FC3F7', unsung: 'FFFFFF', outline: '0D47A1' },
};

// Font phụ đề (đủ dấu tiếng Việt) + bộ màu đi kèm; size: bù cho font trông nhỏ/to hơn.
// file: font đi kèm app (public/fonts, chép vào thư mục dựng khi đốt phụ đề); còn lại có sẵn trên macOS.
const FONTS_DIR = path.join(__dirname, '..', 'public', 'fonts');
const CAPTION_FONTS = [
  { name: 'Patrick Hand', label: 'Viết tay tròn', preset: 'mint', size: 1.3, file: 'PatrickHand-Regular.ttf' },
  { name: 'Arial Rounded MT Bold', label: 'Tròn mềm', preset: 'candy' },
  { name: 'Chalkboard SE', label: 'Phấn bảng', preset: 'sunny' },
  { name: 'Marker Felt', label: 'Bút dạ', preset: 'fire' },
  { name: 'Noteworthy', label: 'Viết tay', preset: 'mint', size: 1.1 },
  { name: 'Phosphate', label: 'Poster đậm', preset: 'pop' },
  { name: 'SignPainter', label: 'Bảng hiệu', preset: 'gold', size: 1.2 },
  { name: 'Superclarendon', label: 'Chữ chân to', preset: 'berry', size: 0.9 },
  { name: 'Luminari', label: 'Cổ tích', preset: 'magic' },
  { name: 'Avenir Next', label: 'Hiện đại', preset: 'ocean' },
  { name: 'American Typewriter', label: 'Đánh máy', preset: 'classic' },
];

const cache = new Map();
const lastSave = new Map();
const controllers = new Map();
let queue = Promise.resolve();

const httpError = (status, message) => Object.assign(new Error(message), { status });
const clamp = (v, a, b, d) => {
  v = Number(v);
  return isFinite(v) ? Math.min(b, Math.max(a, v)) : d;
};
const pick = (v, list, d) => (list.includes(v) ? v : d);
const num = (v) => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Math.max(0, Math.round(Number(v) * 1000) / 1000));

const mdir = (id) => {
  if (!isId(id)) throw httpError(404, 'Dự án nhạc không tồn tại');
  return path.join(ROOT, id);
};
const slugify = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120);
/** Tên thư mục chưa dùng cho tên dự án: con-co-be-be, con-co-be-be-2… */
function uniqueId(name) {
  let base = slugify(name) || 'video-nhac';
  if (RESERVED_IDS.includes(base)) base += '-1';
  for (let i = 1; ; i++) {
    const id = i === 1 ? base : `${base}-${i}`;
    if (!fs.existsSync(path.join(ROOT, id))) return id;
  }
}
/** Tên file video xuất ra = tên video (bỏ ký tự không hợp lệ trong tên file). */
const videoFileName = (title) => {
  const n = String(title || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 100).trim();
  return n ? `${n}.mp4` : '';
};
const videoFile = (p) => p.files?.videoFile || 'output.mp4';
const clipPath = (id, f) => path.join(mdir(id), 'clips', f);
const thumbName = (f) => `thumb_${f.replace(/\.[^.]+$/, '')}.jpg`;
const isVideo = (f) => VIDEO_EXT.includes(path.extname(f).toLowerCase());

// ---------- lưu trữ ----------
function persist(p, force = true) {
  const now = Date.now();
  if (!force && now - (lastSave.get(p.id) || 0) < 400) return;
  lastSave.set(p.id, now);
  p.updatedAt = new Date().toISOString();
  const file = path.join(mdir(p.id), 'project.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(p, null, 2));
  fs.renameSync(file + '.tmp', file);
}

/** Dự án tạo trước khi chuyển sang clip (dùng ảnh): chuyển ảnh sang thư mục clips. */
function migrate(p) {
  if (!Array.isArray(p.images)) return p;
  const dir = mdir(p.id);
  fs.mkdirSync(path.join(dir, 'clips'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'thumbs'), { recursive: true });
  p.clips = [];
  p.clipNames = {};
  p.clipInfo = {};
  p.clipFx = p.imageFx || {};
  for (const f of p.images) {
    try {
      fs.renameSync(path.join(dir, 'images', f), clipPath(p.id, f));
      p.clips.push(f);
      p.clipNames[f] = p.imageNames?.[f] || f;
      p.clipInfo[f] = { kind: 'image', dur: 0 };
    } catch (_) {}
  }
  p.lines = (p.lines || []).map((l) => ({ text: l.text, start: l.start, end: l.end, clip: l.img || null }));
  p.introClip = null;
  p.beats = null;
  p.arrange = null;
  delete p.images;
  delete p.imageNames;
  delete p.imageFx;
  fs.rmSync(path.join(dir, 'images'), { recursive: true, force: true });
  persist(p);
  return p;
}

function load(id) {
  if (cache.has(id)) return cache.get(id);
  let p;
  try {
    p = JSON.parse(fs.readFileSync(path.join(mdir(id), 'project.json'), 'utf8'));
  } catch (_) {
    throw httpError(404, 'Dự án nhạc không tồn tại');
  }
  p.options = normalizeOptions(p.options); // dự án cũ: thêm tuỳ chọn mới với giá trị mặc định
  cache.set(id, p);
  return migrate(p);
}

const DEFAULT_FONT = 'Patrick Hand';

function normalizeOptions(o = {}) {
  const c = o.captions || {};
  return {
    orientation: pick(o.orientation, ['landscape', 'portrait'], 'landscape'),
    resolution: pick(Number(o.resolution), [480, 720, 1080, 1440], 1080),
    fps: pick(Number(o.fps), [24, 30, 60], 30),
    fit: pick(o.fit, ['blur', 'cover', 'color'], 'cover'),
    bgColor: /^#[0-9a-f]{6}$/i.test(o.bgColor || '') ? o.bgColor : '#fff4d6',
    motion: pick(o.motion, ['none', 'zoom', 'mix'], 'zoom'), // chỉ cho asset là ảnh tĩnh
    strength: clamp(o.strength, 0.03, 0.2, 0.08),
    transition: pick(o.transition, ['none', 'fade'], 'fade'),
    cutOnBeat: o.cutOnBeat !== false,
    maxShot: clamp(o.maxShot, 1.5, 20, 5), // một cảnh dài quá mức này thì đổi clip (đúng nhịp)
    normalizeAudio: o.normalizeAudio !== false,
    muteClips: o.muteClips !== false, // mặc định tắt tiếng mọi clip, chỉ nghe bài hát
    clipVolume: clamp(o.clipVolume, 0, 1.5, 0.5), // âm lượng tiếng clip khi bật
    removeWatermark: o.removeWatermark !== false, // xoá logo ngôi sao Gemini ở góc dưới phải clip video
    fxAll: [...new Set((Array.isArray(o.fxAll) ? o.fxAll : []).filter((x) => FX_IDS.includes(x)))],
    fxDensity: clamp(o.fxDensity, 0.3, 2.5, 1),
    titleIntro: o.titleIntro !== false,
    captions: {
      on: c.on !== false,
      karaoke: c.karaoke === true,
      preset: pick(c.preset, Object.keys(CAPTION_PRESETS), 'mint'),
      font: String(c.font || DEFAULT_FONT).replace(/[,\n\r{}]/g, '').slice(0, 60) || DEFAULT_FONT,
      position: pick(c.position, ['bottom', 'middle', 'top'], 'bottom'),
      sizeMul: clamp(c.sizeMul, 0.6, 2, 1),
      uppercase: !!c.uppercase,
    },
  };
}

function create(name) {
  // tên rỗng = dự án nháp: thư mục tạm (video-nhac…), đổi theo tên dự án khi bấm Dựng
  name = cleanName(name);
  const id = uniqueId(name);
  fs.mkdirSync(path.join(mdir(id), 'clips'), { recursive: true });
  fs.mkdirSync(path.join(mdir(id), 'thumbs'), { recursive: true });
  const p = {
    id,
    kind: 'music',
    name,
    title: name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'idle',
    job: null,
    progress: 0,
    message: '',
    error: '',
    logs: [],
    song: null,
    songName: '',
    songDuration: 0,
    beats: null, // { bpm, beats: [giây], bars: [giây], confidence }
    lyricsRaw: '',
    sectionLyrics: '', // lời có nhãn đoạn ([Intro], [Verse 1], [Chorus]…) để tìm mốc các đoạn
    introTitle: '', // tên bài hiện giữa màn hình lúc nhạc dạo (bắt buộc khi dựng)
    sections: null, // { items: [{ label, start, end, first, lines }], auto, notes, model, at }
    lines: [], // [{ text, start, end, clip }] — start/end (giây) có thể null khi chưa chấm nhịp
    introClip: null, // clip cho đoạn nhạc dạo trước câu đầu
    outroClip: null, // clip cho đoạn nhạc dạo sau câu cuối (tới hết bài)
    clips: [],
    clipNames: {},
    clipInfo: {}, // { [file]: { kind: 'video'|'image', dur, w, h, desc, tags, energy, mood } }
    clipFx: {}, // { [file]: ['stars', 'notes'…] }
    arrange: null, // ghi chú lần AI xếp gần nhất: { notes, model, at }
    options: normalizeOptions({}),
    files: { video: false },
    videoDuration: 0,
  };
  cache.set(id, p);
  persist(p);
  return p;
}

function list() {
  const out = [];
  for (const id of fs.readdirSync(ROOT)) {
    if (!isId(id)) continue;
    try {
      const p = load(id);
      out.push({
        id: p.id,
        name: p.name || '',
        title: p.name || 'Nháp (chưa đặt tên)',
        status: p.status,
        progress: p.progress,
        updatedAt: p.updatedAt,
        orientation: p.options.orientation,
        resolution: p.options.resolution,
        thumb: p.clips[0] ? (p.clipInfo[p.clips[0]]?.kind === 'image' ? `/mfiles/${p.id}/clips/${p.clips[0]}` : `/mfiles/${p.id}/thumbs/${thumbName(p.clips[0])}`) : null,
        songDuration: p.songDuration,
        lines: p.lines.length,
        clips: p.clips.length,
        hasVideo: p.files.video,
        videoFile: videoFile(p),
        videoDuration: p.videoDuration,
      });
    } catch (_) {}
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

function publicProject(p) {
  const base = `/mfiles/${p.id}`;
  return {
    ...p,
    clipList: p.clips.map((f) => ({ file: f, name: p.clipNames[f] || f, url: `${base}/clips/${f}`, thumb: `${base}/thumbs/${thumbName(f)}`, info: p.clipInfo[f] || {}, fx: p.clipFx[f] || [] })),
    songUrl: p.song ? `${base}/${p.song}` : null,
    videoFile: videoFile(p),
    videoUrl: p.files.video ? `${base}/${encodeURIComponent(videoFile(p))}?v=${encodeURIComponent(p.updatedAt)}` : null,
  };
}

/** Thư mục dự án theo tên dự án (con-co-be-be): đổi tên thư mục (id) khi bấm Dựng. */
function moveDir(p) {
  const want = slugify(p.name) || 'video-nhac';
  // đã đúng tên (kể cả bản đánh số con-co-be-be-2) thì giữ thư mục
  if (p.id === want || p.id.replace(/-\d+$/, '') === want) return p;
  const old = p.id;
  const nid = uniqueId(p.name);
  fs.renameSync(mdir(old), mdir(nid));
  cache.delete(old);
  lastSave.delete(old);
  p.id = nid;
  cache.set(nid, p);
  persist(p);
  return p;
}

function remove(id) {
  const dir = mdir(id);
  controllers.get(id)?.abort();
  cache.delete(id);
  lastSave.delete(id);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- tài nguyên ----------
function assetTarget(id, kind, origName) {
  load(id);
  const ext = path.extname(String(origName || '')).toLowerCase();
  const ok = kind === 'clip' ? [...VIDEO_EXT, ...IMG_EXT] : AUDIO_EXT;
  if (!ok.includes(ext)) throw httpError(400, `Định dạng không hỗ trợ (${ext || 'không có đuôi'}). Cho phép: ${ok.join(' ')}`);
  const stamp = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  if (kind === 'clip') {
    fs.mkdirSync(path.join(mdir(id), 'clips'), { recursive: true });
    const file = `clip_${stamp}${ext}`;
    return { file, full: clipPath(id, file) };
  }
  const file = `song_${stamp}${ext}`;
  return { file, full: path.join(mdir(id), file) };
}

/** Clip có luồng âm thanh không. */
async function hasAudio(settings, file) {
  try {
    const { out } = await FF.run(settings.ffprobePath, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file]);
    return out.trim().length > 0;
  } catch (_) {
    return false;
  }
}

const MARK_V = 1; // đổi khi cách dò logo Gemini thay đổi -> clip cũ được dò lại
/** Vị trí các logo Gemini trong clip video (dò một lần, lưu vào clipInfo). Lỗi dò thì xoá ở vị trí thường gặp. */
async function clipMarks(settings, file, inf) {
  if (inf.marks && inf.markV === MARK_V) return inf.marks;
  if (!(inf.w && inf.h)) Object.assign(inf, await FF.probeSize(settings.ffprobePath, file));
  try {
    inf.marks = await Watermark.locate(settings, file, inf);
  } catch (_) {
    inf.marks = [Watermark.defaultMark(inf.w, inf.h)];
  }
  inf.markV = MARK_V;
  return inf.marks;
}

/** Ảnh xem trước của clip (khung hình ở ~30% thời lượng), cạnh dài 480px. */
async function makeThumb(settings, src, out, dur) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  if (dur) args.push('-ss', Math.min(dur * 0.3, Math.max(0, dur - 0.1)).toFixed(2));
  args.push('-i', src, '-frames:v', '1', '-vf', "scale='if(gte(iw,ih),480,-2)':'if(gte(iw,ih),-2,480)'", '-q:v', '4', out);
  await FF.run(settings.ffmpegPath, args);
}

async function registerAsset(id, kind, file, origName, settings) {
  const p = load(id);
  const name = String(origName || file).slice(0, 120);
  const dir = mdir(id);
  if (kind === 'clip') {
    const full = clipPath(id, file);
    const info = { kind: isVideo(file) ? 'video' : 'image', dur: 0 };
    try {
      const sz = await FF.probeSize(settings.ffprobePath, full);
      info.w = sz.w;
      info.h = sz.h;
      if (info.kind === 'video') {
        info.dur = Math.round((await FF.probeDuration(settings.ffprobePath, full)) * 1000) / 1000;
        if (info.dur < 0.3) throw new Error('clip quá ngắn');
        info.audio = await hasAudio(settings, full);
        await clipMarks(settings, full, info);
      }
      fs.mkdirSync(path.join(dir, 'thumbs'), { recursive: true });
      await makeThumb(settings, full, path.join(dir, 'thumbs', thumbName(file)), info.dur);
    } catch (e) {
      fs.rmSync(full, { force: true });
      throw httpError(400, `Không đọc được ${info.kind === 'video' ? 'video' : 'ảnh'} "${name}": ${e.message.split('\n').pop()}`);
    }
    p.clipNames[file] = name;
    p.clipInfo[file] = info;
    p.clips.push(file);
  } else {
    const full = path.join(dir, file);
    let dur;
    try {
      dur = await FF.probeDuration(settings.ffprobePath, full);
    } catch (e) {
      fs.rmSync(full, { force: true });
      throw httpError(400, 'Không đọc được file nhạc: ' + e.message);
    }
    if (p.song && p.song !== file) fs.rmSync(path.join(dir, p.song), { force: true });
    p.song = file;
    p.songName = name;
    p.songDuration = dur;
    p.beats = null;
    p.sections = null; // bài mới: mốc đoạn cũ không còn đúng
    try {
      p.beats = await Beats.detect(settings.ffmpegPath, full);
    } catch (_) {
      /* không dò được nhịp: vẫn dựng được, chỉ không cắt theo nhịp */
    }
    if (!p.title) p.title = name.replace(/\.[^.]+$/, '').slice(0, 120);
  }
  persist(p);
  return p;
}

// ---------- video intro / outro (dùng chung cho mọi video nhạc, bắt buộc): intro nối vào đầu, outro nối vào cuối ----------
const BUMPER_LABEL = { intro: 'intro', outro: 'outro' };
const BUMPER_DIR = { intro: path.join(ROOT, 'intro'), outro: path.join(ROOT, 'outro') };
const BUMPER_RE = { intro: /^intro_[\w.\-]+$/, outro: /^outro_[\w.\-]+$/ };
const INTRO_DIR = BUMPER_DIR.intro;
const INTRO_RE = BUMPER_RE.intro;
const OUTRO_DIR = BUMPER_DIR.outro;
const OUTRO_RE = BUMPER_RE.outro;
const bumperMeta = (k) => path.join(BUMPER_DIR[k], `${k}.json`);

/** { file, name, dur, w, h, audio, url } hoặc null nếu chưa có / file đã mất. k: 'intro' | 'outro'. */
function getBumper(k) {
  try {
    const m = JSON.parse(fs.readFileSync(bumperMeta(k), 'utf8'));
    if (!BUMPER_RE[k].test(m.file) || !fs.existsSync(path.join(BUMPER_DIR[k], m.file))) return null;
    return { ...m, url: `/m${k}/${m.file}` };
  } catch (_) {
    return null;
  }
}

function bumperTarget(k, origName) {
  const ext = path.extname(String(origName || '')).toLowerCase();
  if (!VIDEO_EXT.includes(ext)) throw httpError(400, `${BUMPER_LABEL[k][0].toUpperCase() + BUMPER_LABEL[k].slice(1)} phải là file video (${VIDEO_EXT.join(' ')}).`);
  fs.mkdirSync(BUMPER_DIR[k], { recursive: true });
  const file = `${k}_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}${ext}`;
  return { file, full: path.join(BUMPER_DIR[k], file) };
}

async function registerBumper(k, file, origName, settings) {
  const full = path.join(BUMPER_DIR[k], file);
  const info = { file, name: String(origName || file).slice(0, 120) };
  try {
    const sz = await FF.probeSize(settings.ffprobePath, full);
    info.w = sz.w;
    info.h = sz.h;
    info.dur = Math.round((await FF.probeDuration(settings.ffprobePath, full)) * 1000) / 1000;
    if (!(info.dur >= 0.3)) throw new Error('video quá ngắn');
    info.audio = await hasAudio(settings, full);
  } catch (e) {
    fs.rmSync(full, { force: true });
    throw httpError(400, `Không đọc được video ${BUMPER_LABEL[k]} "${info.name}": ${e.message.split('\n').pop()}`);
  }
  const old = getBumper(k);
  fs.writeFileSync(bumperMeta(k), JSON.stringify(info, null, 2));
  if (old && old.file !== file) fs.rmSync(path.join(BUMPER_DIR[k], old.file), { force: true });
  return getBumper(k);
}

function removeBumper(k) {
  const old = getBumper(k);
  fs.rmSync(bumperMeta(k), { force: true });
  if (old) fs.rmSync(path.join(BUMPER_DIR[k], old.file), { force: true });
}

const getIntro = () => getBumper('intro');
const getOutro = () => getBumper('outro');

// ---------- logo kênh (dùng chung, tuỳ chọn): góc video, chỉ hiện phần bài hát (sau intro) ----------
const LOGO_DIR = path.join(ROOT, 'logo');
const LOGO_META = path.join(LOGO_DIR, 'logo.json');
const LOGO_RE = /^logo_[\w.\-]+$/;
const LOGO_SIZE = 0.1;

function normalizeLogoOpts(o = {}, d = {}) {
  return {
    position: 'tr', // cố định: góc trên phải
    size: LOGO_SIZE, // cố định: bề ngang logo = 10% bề ngang video
    opacity: clamp(o.opacity, 0.1, 1, d.opacity ?? 1),
    removeBg: typeof o.removeBg === 'boolean' ? o.removeBg : d.removeBg ?? true,
  };
}

/** { src, file, name, w, h, removed, position, size, opacity, removeBg, url, srcUrl } hoặc null. */
function getLogo() {
  try {
    const m = JSON.parse(fs.readFileSync(LOGO_META, 'utf8'));
    if (!LOGO_RE.test(m.file) || !fs.existsSync(path.join(LOGO_DIR, m.file))) return null;
    return { ...m, ...normalizeLogoOpts(m), url: `/mlogo/${m.file}`, srcUrl: `/mlogo/${m.src}` };
  } catch (_) {
    return null;
  }
}

function logoTarget(origName) {
  const ext = path.extname(String(origName || '')).toLowerCase();
  if (!IMG_EXT.includes(ext)) throw httpError(400, `Logo phải là file ảnh (${IMG_EXT.join(' ')}).`);
  fs.mkdirSync(LOGO_DIR, { recursive: true });
  const file = `logo_src_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}${ext}`;
  return { file, full: path.join(LOGO_DIR, file) };
}

/** Tách nền + cắt sát ảnh gốc -> PNG mới; ghi lại thông tin logo, xoá file cũ không còn dùng. */
async function buildLogo(src, name, opts, settings) {
  const file = `logo_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}.png`;
  let r;
  try {
    r = await Logo.processLogo(settings, path.join(LOGO_DIR, src), path.join(LOGO_DIR, file), { removeBg: opts.removeBg });
  } catch (e) {
    fs.rmSync(path.join(LOGO_DIR, file), { force: true });
    throw httpError(400, `Không xử lý được logo "${name}": ${e.message.split('\n').pop()}`);
  }
  const old = getLogo();
  fs.writeFileSync(LOGO_META, JSON.stringify({ src, file, name, w: r.w, h: r.h, removed: r.removed, ...opts }, null, 2));
  if (old) for (const f of [old.file, old.src]) if (f !== file && f !== src) fs.rmSync(path.join(LOGO_DIR, f), { force: true });
  return getLogo();
}

async function registerLogo(src, origName, settings) {
  const name = String(origName || src).slice(0, 120);
  try {
    return await buildLogo(src, name, normalizeLogoOpts({}, getLogo() || {}), settings);
  } catch (e) {
    fs.rmSync(path.join(LOGO_DIR, src), { force: true });
    throw e;
  }
}

/** Đổi vị trí / cỡ / độ mờ; đổi "xoá nền" thì xử lý lại ảnh gốc. */
async function updateLogo(data, settings) {
  const cur = getLogo();
  if (!cur) throw httpError(404, 'Chưa có logo.');
  const opts = normalizeLogoOpts({ ...cur, ...data }, cur);
  if (opts.removeBg !== cur.removeBg) return buildLogo(cur.src, cur.name, opts, settings);
  fs.writeFileSync(LOGO_META, JSON.stringify({ src: cur.src, file: cur.file, name: cur.name, w: cur.w, h: cur.h, removed: cur.removed, ...opts }, null, 2));
  return getLogo();
}

function removeLogo() {
  const old = getLogo();
  fs.rmSync(LOGO_META, { force: true });
  if (old) for (const f of [old.file, old.src]) fs.rmSync(path.join(LOGO_DIR, f), { force: true });
}

// ---------- lời bài hát ----------
/** Giây -> "mm:ss.xx" (LRC). */
function fmtLrc(t) {
  const cs = Math.max(0, Math.round(t * 100));
  return `${String(Math.floor(cs / 6000)).padStart(2, '0')}:${String(Math.floor((cs % 6000) / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/**
 * Đọc lời bài hát: tự nhận SRT (có "-->"), LRC ([mm:ss.xx] lời) hoặc lời thường (mỗi dòng một câu, chưa có thời gian).
 * Dòng chỉ gồm nhãn đoạn như "[Điệp khúc]" / "ĐK:" bị bỏ qua.
 */
function parseLyrics(text) {
  const raw = String(text || '').replace(/\r/g, '').replace(/^﻿/, '').slice(0, 300000);
  if (raw.includes('-->')) {
    return { format: 'srt', lines: S.parseSrt(raw).slice(0, MAX_LINES).map((c) => ({ text: c.text.slice(0, 300), start: num(c.start), end: num(c.end), clip: null })) };
  }
  const TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const timed = [];
  let lrcLines = 0;
  const plain = [];
  for (const line of raw.split('\n')) {
    const tags = [...line.matchAll(TAG)];
    // bỏ cả mốc từng chữ kiểu LRC mở rộng <mm:ss.xx>
    const txt = line.replace(TAG, '').replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').replace(/\s+/g, ' ').trim();
    if (tags.length) {
      lrcLines++;
      if (!txt) continue;
      for (const m of tags) timed.push({ text: txt.slice(0, 300), start: +m[1] * 60 + +m[2] + (m[3] ? Number('0.' + m[3]) : 0), end: null, clip: null });
      continue;
    }
    if (/^\[[a-z]{1,8}:.*\]$/i.test(txt)) continue; // [ar:…] [ti:…]
    if (!txt || /^\[.*\]$/.test(txt) || /^\(.*\)$/.test(txt) || /^(đk|điệp khúc|chorus|verse|lời \d+|intro|outro)\s*\d*\s*:?$/i.test(txt)) continue;
    plain.push({ text: txt.slice(0, 300), start: null, end: null, clip: null });
  }
  if (lrcLines && timed.length) {
    timed.sort((a, b) => a.start - b.start);
    return { format: 'lrc', lines: timed.slice(0, MAX_LINES).map((l) => ({ ...l, start: num(l.start) })) };
  }
  return { format: 'plain', lines: plain.slice(0, MAX_LINES) };
}

function normalizeLines(lines, clips) {
  const ok = (f) => typeof f === 'string' && clips.includes(f);
  return (Array.isArray(lines) ? lines : []).slice(0, MAX_LINES).map((l) => {
    const text = String(l?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const start = num(l?.start);
    let end = num(l?.end);
    if (start !== null && end !== null && end <= start) end = null;
    const clip = ok(l?.clip) ? l.clip : null;
    return { text, start, end, clip };
  }).filter((l) => l.text);
}

/**
 * Điền thời gian cho các câu chưa chấm: chia đều (theo độ dài câu) giữa hai mốc đã biết.
 * Trả về [{ text, start, end, fill, clip }] — fill: thời gian chữ được tô hết (karaoke).
 */
function timeLines(lines, dur) {
  const out = lines.map((l) => ({ ...l }));
  const n = out.length;
  let i = 0;
  while (i < n) {
    if (out[i].start !== null) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && out[j].start === null) j++;
    const prev = i > 0 ? out[i - 1] : null;
    const a = prev ? (prev.end ?? prev.start + Math.min(6, Math.max(2, prev.text.length * 0.12))) : 0;
    const b = j < n ? out[j].start : dur;
    const w = out.slice(i, j).map((l) => l.text.length + 8);
    const total = w.reduce((x, y) => x + y, 0) || 1;
    let t = Math.min(a, b);
    const span = Math.max(0, b - t);
    for (let k = i; k < j; k++) {
      out[k].start = t;
      out[k].guess = true;
      t += (span * w[k - i]) / total;
      out[k].end = t;
    }
    i = j;
  }
  for (let k = 0; k < n; k++) {
    const l = out[k];
    const next = k + 1 < n ? out[k + 1].start : dur;
    const natural = Math.max(2.5, l.text.split(/\s+/).length * 0.75 + 1);
    if (l.end === null) {
      // không có mốc kết thúc: kéo tới câu sau, nhưng không giữ quá lâu qua đoạn nhạc dạo
      l.end = Math.min(next, l.start + Math.max(natural, 4));
      l.fill = Math.max(0.3, Math.min(l.end - l.start, next - l.start) * (l.end >= next - 0.01 ? 0.92 : 0.85));
    } else l.fill = l.end - l.start;
    l.end = Math.min(l.end, next > l.start ? next : l.end, dur);
    l.fill = Math.max(0.2, Math.min(l.fill, l.end - l.start));
  }
  return out.filter((l) => l.end > l.start + 0.05);
}


// ---------- áp dữ liệu từ form ----------
function applyData(p, data) {
  if (typeof data.name === 'string') p.name = cleanName(data.name);
  if (typeof data.title === 'string') p.title = data.title.replace(/[\r\n]+/g, ' ').slice(0, 120);
  if (typeof data.introTitle === 'string') p.introTitle = data.introTitle.replace(/\s+/g, ' ').slice(0, 120);
  if (typeof data.lyricsRaw === 'string') p.lyricsRaw = data.lyricsRaw.replace(/\r/g, '').slice(0, 300000);
  if (typeof data.sectionLyrics === 'string') p.sectionLyrics = data.sectionLyrics.replace(/\r/g, '').slice(0, 300000);
  if (Array.isArray(data.sections) && p.sections) p.sections.items = normalizeSections(data.sections, p.songDuration);
  if (data.options) p.options = normalizeOptions(data.options);
  if (Array.isArray(data.clips)) {
    // chỉ đổi thứ tự; clip form chưa biết (vừa tải lên) giữ ở cuối. Xoá clip dùng removeClip().
    const order = data.clips.filter((f, i, a) => typeof f === 'string' && p.clips.includes(f) && a.indexOf(f) === i);
    p.clips = [...order, ...p.clips.filter((f) => !order.includes(f))];
  }
  if (data.clipFx && typeof data.clipFx === 'object') {
    p.clipFx = {};
    for (const f of p.clips) {
      const fx = [...new Set((Array.isArray(data.clipFx[f]) ? data.clipFx[f] : []).filter((x) => FX_IDS.includes(x)))];
      if (fx.length) p.clipFx[f] = fx;
    }
  }
  for (const f of Object.keys(p.clipFx)) if (!p.clips.includes(f)) delete p.clipFx[f];
  if (Array.isArray(data.lines)) p.lines = normalizeLines(data.lines, p.clips);
  else p.lines = normalizeLines(p.lines, p.clips);
  if (data.introClip !== undefined) p.introClip = typeof data.introClip === 'string' && p.clips.includes(data.introClip) ? data.introClip : null;
  else if (p.introClip && !p.clips.includes(p.introClip)) p.introClip = null;
  if (data.outroClip !== undefined) p.outroClip = typeof data.outroClip === 'string' && p.clips.includes(data.outroClip) ? data.outroClip : null;
  else if (p.outroClip && !p.clips.includes(p.outroClip)) p.outroClip = null;
  if (data.song === null && p.song) {
    fs.rmSync(path.join(mdir(p.id), p.song), { force: true });
    p.song = null;
    p.songName = '';
    p.songDuration = 0;
    p.beats = null;
  }
  persist(p);
}

function removeClip(id, file) {
  const p = load(id);
  if (!p.clips.includes(file)) throw httpError(404, 'Không có clip này');
  return removeClips(id, [file]);
}

/** Xoá nhiều clip một lần (bỏ qua tên không có trong dự án). */
function removeClips(id, files) {
  const p = load(id);
  if (p.status === 'queued' || p.status === 'running') throw httpError(409, 'Dự án đang dựng, chờ xong rồi sửa.');
  const del = new Set((Array.isArray(files) ? files : []).filter((f) => typeof f === 'string' && p.clips.includes(f)));
  if (!del.size) throw httpError(400, 'Chưa chọn clip nào để xoá');
  for (const file of del) {
    fs.rmSync(clipPath(p.id, file), { force: true });
    fs.rmSync(path.join(mdir(p.id), 'thumbs', thumbName(file)), { force: true });
    delete p.clipNames[file];
    delete p.clipInfo[file];
    delete p.clipFx[file];
  }
  p.clips = p.clips.filter((f) => !del.has(f));
  if (del.has(p.introClip)) p.introClip = null;
  if (del.has(p.outroClip)) p.outroClip = null;
  p.lines = normalizeLines(p.lines, p.clips);
  persist(p);
  return p;
}

// ---------- phụ đề ASS: karaoke + hiệu ứng ----------
const assColor = (hex) => `&H${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}&`;
const assStyleColor = (hex, a = '00') => `&H${a}${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`;
function assTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  const hh = Math.floor(cs / 360000);
  const mm = Math.floor((cs % 360000) / 6000);
  const ss = Math.floor((cs % 6000) / 100);
  return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}
const assText = (s) => s.replace(/[{}]/g, (m) => (m === '{' ? '(' : ')')).replace(/\\/g, '/');

/** Bộ sinh số ngẫu nhiên có hạt giống -> dựng lại cho kết quả giống hệt. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// hình vector ASS (\p1), toạ độ quanh 0..100
const r1 = (n) => Math.round(n * 10) / 10;
function starShape() {
  const pts = [];
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rr = k % 2 ? 21 : 50;
    pts.push(`${r1(50 + rr * Math.cos(a))} ${r1(50 + rr * Math.sin(a))}`);
  }
  return `m ${pts[0]} l ${pts.slice(1).join(' ')}`;
}
const circleShape = (r = 50) => {
  const k = r1(r * 0.5523);
  return `m ${r} 0 b ${r + k} 0 ${2 * r} ${r - k} ${2 * r} ${r} b ${2 * r} ${r + k} ${r + k} ${2 * r} ${r} ${2 * r} b ${r - k} ${2 * r} 0 ${r + k} 0 ${r} b 0 ${r - k} ${r - k} 0 ${r} 0`;
};
const SHAPES = {
  star: starShape(),
  circle: circleShape(50),
  heart: 'm 50 28 b 50 6 12 -2 4 26 b -4 52 30 70 50 92 b 70 70 104 52 96 26 b 88 -2 50 6 50 28',
  rect: 'm 0 0 l 100 0 100 50 0 50',
  balloon: 'm 50 0 b 80 0 98 24 98 50 b 98 80 74 104 54 110 l 58 118 42 118 46 110 b 26 104 2 80 2 50 b 2 24 20 0 50 0',
};
const PALETTE = ['FF5FA8', 'FFD400', '3DC2FF', '7CE35A', 'FF8A3D', 'B07CFF', 'FF4D5E'];

/** Các dòng ASS cho hiệu ứng trong khoảng [a, b] giây. */
function fxEvents(id, a, b, { W, H, density, seed }) {
  const R = rng(seed);
  const m = Math.min(W, H);
  const rnd = (lo, hi) => lo + (hi - lo) * R();
  const pickc = () => PALETTE[Math.floor(R() * PALETTE.length)];
  const span = b - a;
  const ev = [];
  // mv: [x1, y1, x2, y2] đường bay cả đời hạt; bị cắt ở đầu / cuối cảnh thì lấy đúng đoạn giữa đường
  const add = (t0, life, mv, tags, body, layer = 1) => {
    const s = Math.max(a, t0);
    const e = Math.min(b, t0 + life);
    if (e - s < 0.3) return;
    const lifeMs = Math.round((e - s) * 1000);
    const fin = Math.min(400, Math.round(lifeMs / 3));
    let move = '';
    if (mv) {
      const at = (t) => [mv[0] + (mv[2] - mv[0]) * ((t - t0) / life), mv[1] + (mv[3] - mv[1]) * ((t - t0) / life)].map(Math.round);
      move = `\\move(${at(s).join(',')},${at(e).join(',')},0,${lifeMs})`;
    }
    ev.push(`Dialogue: ${layer},${assTime(s)},${assTime(e)},Fx,,0,0,0,,{\\an5\\fad(${fin},${fin})${move}${tags.replace(/LIFE/g, lifeMs)}}${body}`);
  };
  const count = (rate) => Math.max(1, Math.round(span * rate * density));
  const P = (shape) => `{\\p1}${SHAPES[shape]}`;
  const sc = (px) => Math.max(5, Math.round(px)); // \fscx theo %: hình gốc 100 đơn vị = px khi scale = px%

  if (id === 'stars') {
    for (let k = 0, n = count(3); k < n; k++) {
      const t0 = a + R() * span;
      const s = sc(rnd(0.04, 0.075) * m);
      const c = R() < 0.6 ? 'FFE45C' : 'FFFFFF';
      add(t0, rnd(1.2, 2.2), null, `\\pos(${Math.round(rnd(0.04, 0.96) * W)},${Math.round(rnd(0.04, 0.7) * H)})\\bord0\\shad0\\1c${assColor(c)}\\blur1\\fscx0\\fscy0\\t(0,${Math.round(400)},\\fscx${s}\\fscy${s})\\t(${Math.round(400)},LIFE,\\fscx${Math.round(s * 0.4)}\\fscy${Math.round(s * 0.4)}\\frz${Math.round(rnd(-90, 90))})`, P('star'));
    }
  } else if (id === 'bubbles') {
    for (let k = 0, n = count(1.4); k < n; k++) {
      const t0 = a + R() * span - 2;
      const s = sc(rnd(0.035, 0.08) * m);
      const x = rnd(0.03, 0.97) * W;
      const life = rnd(5, 8);
      add(t0, life, [Math.round(x), Math.round(H + s), Math.round(x + rnd(-0.08, 0.08) * W), Math.round(rnd(-0.1, 0.35) * H)], `\\1c${assColor('BFE9FF')}\\1a&HC8&\\3c${assColor('FFFFFF')}\\3a&H30&\\bord${Math.max(2, Math.round(m * 0.003))}\\shad0\\fscx${s}\\fscy${s}`, P('circle'));
    }
  } else if (id === 'notes') {
    const glyphs = ['♪', '♫', '♬', '♩'];
    for (let k = 0, n = count(1.1); k < n; k++) {
      const t0 = a + R() * span - 1;
      const x = rnd(0.05, 0.95) * W;
      const y0 = rnd(0.55, 0.95) * H;
      add(t0, rnd(3, 5), [Math.round(x), Math.round(y0), Math.round(x + rnd(-0.06, 0.06) * W), Math.round(y0 - rnd(0.25, 0.45) * H)], `\\fs${Math.round(rnd(0.075, 0.12) * m)}\\1c${assColor(pickc())}\\3c${assColor('FFFFFF')}\\bord${Math.max(2, Math.round(m * 0.003))}\\shad0\\frz${Math.round(rnd(-15, 15))}\\t(\\frz${Math.round(rnd(-25, 25))})`, glyphs[Math.floor(R() * glyphs.length)]);
    }
  } else if (id === 'hearts') {
    for (let k = 0, n = count(1.1); k < n; k++) {
      const t0 = a + R() * span - 1;
      const s = sc(rnd(0.05, 0.09) * m);
      const x = rnd(0.05, 0.95) * W;
      const y0 = rnd(0.6, 1) * H;
      const c = ['FF5FA8', 'FF4D5E', 'FF8FC7'][Math.floor(R() * 3)];
      add(t0, rnd(3, 5), [Math.round(x), Math.round(y0), Math.round(x + rnd(-0.05, 0.05) * W), Math.round(y0 - rnd(0.3, 0.5) * H)], `\\1c${assColor(c)}\\3c${assColor('FFFFFF')}\\bord${Math.max(2, Math.round(m * 0.003))}\\shad0\\fscx${Math.round(s * 0.3)}\\fscy${Math.round(s * 0.3)}\\t(0,350,\\fscx${s}\\fscy${s})\\frz${Math.round(rnd(-20, 20))}`, P('heart'));
    }
  } else if (id === 'confetti') {
    for (let k = 0, n = count(7); k < n; k++) {
      const t0 = a + R() * span - 2;
      const s = sc(rnd(0.018, 0.03) * m);
      const x = rnd(0, 1) * W;
      add(t0, rnd(3, 5.5), [Math.round(x), Math.round(-s), Math.round(x + rnd(-0.12, 0.12) * W), Math.round(H + s)], `\\1c${assColor(pickc())}\\bord0\\shad0\\fscx${s}\\fscy${s}\\frz${Math.round(rnd(0, 360))}\\t(\\frz${Math.round(rnd(360, 1080) * (R() < 0.5 ? -1 : 1))}\\frx${Math.round(rnd(180, 720))})`, P('rect'));
    }
  } else if (id === 'balloons') {
    for (let k = 0, n = count(0.45); k < n; k++) {
      const t0 = a + R() * span - 3;
      const s = sc(rnd(0.07, 0.11) * m);
      const x = rnd(0.06, 0.94) * W;
      const c = pickc();
      add(t0, rnd(7, 10), [Math.round(x), Math.round(H + s * 1.4), Math.round(x + rnd(-0.08, 0.08) * W), Math.round(-s * 1.4)], `\\1c${assColor(c)}\\3c${assColor('FFFFFF')}\\3a&H60&\\bord${Math.max(1, Math.round(m * 0.002))}\\shad0\\fscx${s}\\fscy${s}\\frz${Math.round(rnd(-8, 8))}\\t(\\frz${Math.round(rnd(-8, 8))})`, P('balloon'), 0);
    }
  }
  return ev;
}

/** File ASS: lời karaoke + tiêu đề lúc nhạc dạo + hiệu ứng theo từng cảnh. */
function buildAss({ lines, scenes, clipFx, o, W, H, title, T }) {
  const c = o.captions;
  const pr = CAPTION_PRESETS[c.preset];
  const m = Math.min(W, H);
  const fk = CAPTION_FONTS.find((f) => f.name === c.font)?.size || 1;
  const size = Math.round(m * 0.068 * c.sizeMul * fk);
  const align = { bottom: 2, middle: 5, top: 8 }[c.position];
  const marginV = c.position === 'middle' ? 0 : Math.round(H * 0.07);
  const marginLR = Math.round(W * 0.06);
  const ol = Math.max(3, Math.round(size * 0.12));
  const sh = Math.max(2, Math.round(size * 0.06));
  // karaoke: SecondaryColour = chưa hát, PrimaryColour = đã hát (\kf tô dần từ trái sang phải)
  const primary = assStyleColor(c.karaoke ? pr.sung : pr.unsung);
  const secondary = assStyleColor(pr.unsung);
  const out = assStyleColor(pr.outline);
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Lyric,${c.font},${size},${primary},${secondary},${out},&H80000000,-1,0,0,0,100,100,1,0,1,${ol},${sh},${align},${marginLR},${marginLR},${marginV},1`,
    `Style: Title,${c.font},${Math.round(size * 1.6)},${assStyleColor(pr.sung)},${assStyleColor(pr.sung)},${out},&H80000000,-1,0,0,0,100,100,2,0,1,${Math.round(ol * 1.4)},${Math.round(sh * 1.4)},5,${marginLR},${marginLR},0,1`,
    `Style: Fx,Arial Unicode MS,${Math.round(m * 0.06)},&H00FFFFFF,&H00FFFFFF,&H00FFFFFF,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const ev = [];
  const up = (s) => (c.uppercase ? s.toLocaleUpperCase('vi') : s);

  // tiêu đề bài hát: luôn hiện giữa màn hình từ 0 đến 3s
  if (o.titleIntro && title) {
    ev.push(`Dialogue: 6,${assTime(0)},${assTime(Math.min(3, T))},Title,,0,0,0,,{\\an5\\pos(${Math.round(W / 2)},${Math.round(H / 2)})\\fad(400,300)\\fscx70\\fscy70\\t(0,450,\\fscx100\\fscy100)}${assText(up(title))}`);
  }

  if (c.on) {
    lines.forEach((l, i) => {
      const prevEnd = i > 0 ? lines[i - 1].end : 0;
      const lead = Math.max(0, Math.min(0.35, l.start - prevEnd)); // hiện chữ sớm một chút để bé kịp nhìn
      const s = l.start - lead;
      let body;
      if (c.karaoke) {
        const words = up(l.text).split(/\s+/).filter(Boolean);
        const wts = words.map((w) => w.length + 2);
        const tot = wts.reduce((x, y) => x + y, 0) || 1;
        let used = 0;
        const fillCs = Math.round(l.fill * 100);
        body = (lead > 0 ? `{\\k${Math.round(lead * 100)}}` : '') + words.map((w, k) => {
          const d = k === words.length - 1 ? fillCs - used : Math.round((fillCs * wts[k]) / tot);
          used += d;
          return `{\\kf${Math.max(1, d)}}${assText(w)}`;
        }).join(' ');
      } else body = assText(up(l.text));
      ev.push(`Dialogue: 5,${assTime(s)},${assTime(l.end)},Lyric,,0,0,0,,{\\fad(120,120)}${body}`);
    });
  }

  scenes.forEach((sc, i) => {
    const fx = [...new Set([...(clipFx[sc.file] || []), ...o.fxAll])];
    fx.forEach((id, k) => ev.push(...fxEvents(id, sc.start, sc.end, { W, H, density: o.fxDensity, seed: (i + 1) * 7919 + k * 104729 })));
  });
  return head.concat(ev).join('\n') + '\n';
}


// ---------- chia cảnh theo câu hát + nhịp ----------
const textKey = (s) => s.toLocaleLowerCase('vi').normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Nhóm câu lặp lại (điệp khúc): trả về mảng số nhóm (0 = không lặp) cho từng câu. */
function repeatGroups(lines) {
  const count = new Map();
  for (const l of lines) count.set(textKey(l.text), (count.get(textKey(l.text)) || 0) + 1);
  const ids = new Map();
  return lines.map((l) => {
    const k = textKey(l.text);
    if (count.get(k) < 2) return 0;
    if (!ids.has(k)) ids.set(k, ids.size + 1);
    return ids.get(k);
  });
}

/**
 * Danh sách cảnh (shot) cho cả bài: [{ file, start, end, from }] — from: giây bắt đầu trong clip.
 * - Clip đổi ở đầu câu hát (kéo về phách gần nhất nếu bật cắt theo nhịp).
 * - Một clip dùng lại nhiều lần sẽ chạy tiếp đoạn sau của nó (không lặp lại đúng một đoạn).
 */
function planShots(p, lines, T) {
  const o = p.options;
  const info = p.clipInfo;
  const ok = (f) => f && p.clips.includes(f);
  const beats = o.cutOnBeat && p.beats?.beats?.length ? p.beats.beats : [];
  const lists = [];
  lines.forEach((l, i) => {
    lists.push(ok(l.clip) ? [l.clip] : i ? lists[i - 1] : [p.clips[0]]);
  });
  const first = lines[0];
  const introList = ok(p.introClip) ? [p.introClip, ...(lists[0] || []).filter((f) => f !== p.introClip)] : lists[0] || [p.clips[0]];

  // đoạn (segment) = khoảng thời gian dùng chung một danh sách clip
  const segs = [];
  const push = (list, a) => {
    const last = segs[segs.length - 1];
    if (last && last.list.join('|') === list.join('|')) return;
    if (last && a - last.a < 0.8) {
      last.list = list; // đoạn trước quá ngắn: thay luôn
      return;
    }
    segs.push({ list, a });
  };
  if (!first || first.start >= 1) push(introList, 0);
  lines.forEach((l, i) => {
    let a = i === 0 && !segs.length ? 0 : l.start;
    if (beats.length && a > 0) a = Beats.snap(beats, a, 0.25);
    push(lists[i], Math.min(a, T - 0.5));
  });
  // nhạc dạo cuối: sau câu cuối tới hết bài
  const last = lines[lines.length - 1];
  if (last && T - last.end >= 1) {
    const lastList = lists[lists.length - 1];
    const outroList = ok(p.outroClip) ? [p.outroClip, ...lastList.filter((f) => f !== p.outroClip)] : lastList;
    let a = last.end;
    if (beats.length) a = Beats.snap(beats, a, 0.25);
    push(outroList, Math.min(a, T - 0.5));
    if (ok(p.outroClip) && segs[segs.length - 1].list === outroList) segs[segs.length - 1].fresh = true;
  }
  if (!segs.length) segs.push({ list: introList, a: 0 });
  segs[0].a = 0;

  const playhead = {};
  const shots = [];
  segs.forEach((sg, si) => {
    const b = si + 1 < segs.length ? segs[si + 1].a : T;
    let t = sg.a;
    if (sg.fresh) playhead[sg.list[0]] = 0; // clip nhạc dạo cuối chạy từ đầu
    let k = 0;
    let guard = 0;
    while (t < b - 0.05 && guard++ < 500) {
      let f = sg.list[k % sg.list.length];
      const last = shots[shots.length - 1];
      // không chiếu lại đúng clip vừa chiếu khi còn clip khác để đổi
      if (last && last.file === f && sg.list.length > 1) f = sg.list[++k % sg.list.length];
      k++;
      const inf = info[f] || { kind: 'image' };
      let from = 0;
      const outroHead = sg.fresh && t === sg.a; // clip nhạc dạo cuối: chiếu trọn, không cắt theo maxShot
      let len = Math.min(outroHead ? Infinity : o.maxShot, b - t);
      if (inf.kind === 'video') {
        from = playhead[f] || 0;
        if (from > inf.dur - 1) from = 0;
        len = Math.min(len, inf.dur - from);
      }
      let end = t + Math.max(0.3, len);
      if (end < b - 0.05) {
        if (beats.length) {
          // cắt về phách gần nhất trước đó; không có thì kéo tới phách kế tiếp (clip hết thì giữ khung cuối, < 0.6s)
          const bt = Beats.lastBeatIn(beats, t + 0.5, end + 0.01) ?? beats.find((x) => x > end && x - end < 0.6 && x < b);
          if (bt) end = bt;
        }
        if (b - end < (outroHead ? 2.5 : 0.8)) end = b; // phần dư quá ngắn: kéo dài cảnh (clip hết thì đứng ở khung cuối)
      } else end = b;
      const prev = shots[shots.length - 1];
      if (prev && prev.file === f && prev.end === t && (inf.kind !== 'video' || Math.abs(prev.from + (prev.end - prev.start) - from) < 0.01)) prev.end = end;
      else shots.push({ file: f, start: t, end, from });
      if (inf.kind === 'video') playhead[f] = from + (end - t);
      t = end;
    }
  });
  return shots;
}

/**
 * Gán clip tự động (không dùng AI): chia đều clip theo thứ tự cho các câu (hoặc đổi mỗi N câu),
 * câu lặp lại (điệp khúc) dùng lại clip của lần đầu.
 */
function autoAssign(lines, clips, { every = 0, reuseRepeats = true } = {}) {
  if (!clips.length) return lines;
  const seen = new Map();
  const fresh = [];
  lines.forEach((l, i) => {
    if (reuseRepeats && seen.has(textKey(l.text))) return;
    seen.set(textKey(l.text), i);
    fresh.push(i);
  });
  const out = lines.map((l) => ({ ...l }));
  fresh.forEach((li, k) => {
    const idx = every > 0 ? Math.floor(k / every) % clips.length : Math.min(clips.length - 1, Math.floor((k * clips.length) / Math.max(1, fresh.length)));
    out[li].clip = clips[idx];
  });
  if (reuseRepeats) out.forEach((l) => (l.clip = out[seen.get(textKey(l.text))].clip));
  return out;
}

// ---------- AI: xem clip + xếp clip theo nhạc ----------
const AI_CACHE = path.join(ROOT, 'ai-cache.json');
const readAiCache = () => {
  try {
    return JSON.parse(fs.readFileSync(AI_CACHE, 'utf8'));
  } catch (_) {
    return {};
  }
};

const CLIP_SCHEMA = {
  type: 'object',
  properties: {
    desc: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    energy: { type: 'integer' },
    mood: { type: 'string' },
  },
  required: ['desc', 'tags', 'energy', 'mood'],
  additionalProperties: false,
};

/** Ghép 3 khung hình (đầu / giữa / cuối) của clip thành một ảnh ngang để AI xem. */
async function clipStrip(settings, file, inf, out) {
  if (inf.kind !== 'video') {
    await FF.run(settings.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-vf', "scale='if(gte(iw,ih),1024,-2)':'if(gte(iw,ih),-2,1024)'", '-q:v', '4', out]);
    return;
  }
  const ts = [0.12, 0.5, 0.88].map((r) => Math.max(0, Math.min(inf.dur - 0.1, inf.dur * r)).toFixed(2));
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  ts.forEach((t) => args.push('-ss', t, '-i', file));
  const h = 360;
  args.push('-filter_complex', ts.map((_, i) => `[${i}:v]scale=-2:${h},setsar=1[v${i}]`).join(';') + `;[v0][v1][v2]hstack=inputs=3`, '-frames:v', '1', '-q:v', '4', out);
  await FF.run(settings.ffmpegPath, args);
}

/** AI xem một clip -> { desc, tags, energy, mood }. Nhớ theo nội dung khung hình + model -> không tốn tiền lần hai. */
async function describeClip(id, file, settings, { force = false, signal } = {}) {
  const p = load(id);
  if (!p.clips.includes(file)) throw httpError(404, 'Không có clip này');
  const inf = p.clipInfo[file] || { kind: 'image' };
  const tmp = path.join(mdir(id), `strip_${crypto.randomBytes(3).toString('hex')}.jpg`);
  let buf;
  try {
    await clipStrip(settings, clipPath(id, file), inf, tmp);
    buf = fs.readFileSync(tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const provider = settings.aiProvider;
  const model = settings[{ anthropic: 'aiModelAnthropic', gemini: 'aiModelGemini' }[provider]] || '';
  const ck = `clip1:${provider}:${model}:${crypto.createHash('sha1').update(buf).digest('hex')}`;
  let d = force ? null : readAiCache()[ck];
  const cached = !!d;
  if (!d) {
    const prompt = `[task: music-clip] Ảnh này ghép ${inf.kind === 'video' ? '3 khung hình (đầu, giữa, cuối) của MỘT clip video ngắn' : 'một ảnh tĩnh'} dùng làm hình cho video ca nhạc thiếu nhi.
Trả về JSON:
- desc: mô tả nội dung bằng tiếng Việt, tối đa 30 từ: con vật / nhân vật gì, đang làm gì, ở đâu, đồ vật và màu sắc nổi bật, chuyển động trong clip.
- tags: tối đa 8 từ khoá tiếng Việt ngắn (con vật, đồ vật, hành động, nơi chốn) để ghép với lời bài hát.
- energy: mức sôi động 1–5 (1 = tĩnh lặng / chậm rãi, 3 = vừa phải, 5 = nhảy múa / chạy nhảy / chuyển động nhanh).
- mood: một từ tiếng Việt chỉ không khí (vui tươi, êm dịu, ngộ nghĩnh, hào hứng, buồn, bí ẩn…).
Chỉ trả về JSON {"desc": "...", "tags": [...], "energy": 3, "mood": "..."}.`;
    const r = await Vision.ask(settings, { prompt, schema: CLIP_SCHEMA, b64: buf.toString('base64'), effort: 'low', maxTokens: 4000 }, signal);
    d = {
      desc: String(r.data?.desc || '').slice(0, 300),
      tags: (Array.isArray(r.data?.tags) ? r.data.tags : []).slice(0, 8).map((t) => String(t).slice(0, 30)),
      energy: Math.max(1, Math.min(5, Math.round(Number(r.data?.energy) || 3))),
      mood: String(r.data?.mood || '').slice(0, 30),
      model: r.model,
    };
    const next = readAiCache();
    next[ck] = d;
    const keys = Object.keys(next);
    for (const k of keys.slice(0, Math.max(0, keys.length - 3000))) delete next[k];
    fs.writeFileSync(AI_CACHE, JSON.stringify(next));
  }
  const cur = load(id); // có thể đã đổi trong lúc chờ AI
  if (cur.clipInfo[file]) {
    Object.assign(cur.clipInfo[file], { desc: d.desc, tags: d.tags, energy: d.energy, mood: d.mood });
    persist(cur);
  }
  return { file, ...d, cached };
}

const ARRANGE_SCHEMA = {
  type: 'object',
  properties: {
    intro: { type: 'integer' },
    outro: { type: 'integer' },
    lines: {
      type: 'array',
      items: { type: 'object', properties: { clip: { type: 'integer' } }, required: ['clip'], additionalProperties: false },
    },
    unused: { type: 'array', items: { type: 'integer' } },
    notes: { type: 'string' },
  },
  required: ['intro', 'outro', 'lines', 'unused', 'notes'],
  additionalProperties: false,
};

/** AI chọn clip cho từng câu hát theo lời, điệp khúc, nhịp và độ sôi động. Ghi thẳng vào dự án. */
async function aiArrange(id, settings, signal) {
  const p = load(id);
  if (!p.clips.length) throw httpError(400, 'Chưa có clip nào.');
  if (!p.lines.length) throw httpError(400, 'Chưa có lời bài hát — dán lời rồi bấm “Đọc lời” trước.');
  const T = p.songDuration || Math.max(...p.lines.map((l) => l.end ?? l.start ?? 0), 0) + 5;
  const lines = timeLines(p.lines, T);
  if (lines.length !== p.lines.length) throw httpError(400, 'Thời gian câu hát không hợp lệ (có câu nằm ngoài bài hát) — kiểm tra lại bảng chấm nhịp.');
  const groups = repeatGroups(lines);
  const clips = p.clips.map((f) => ({ f, ...(p.clipInfo[f] || {}) }));
  const missing = clips.filter((c) => !c.desc).length;
  const outroLen = T - lines[lines.length - 1].end;
  const bpm = p.beats?.bpm ? `, nhịp khoảng ${Math.round(p.beats.bpm)} BPM` : '';
  const prompt = `[task: music-arrange] Bạn là người dựng video ca nhạc thiếu nhi. Bài hát dài ${Math.round(T)} giây${bpm}. Lời có ${lines.length} câu (đánh số, kèm thời gian bắt đầu–kết thúc theo giây; câu lặp lại được đánh dấu [ĐK n] — cùng n là cùng một câu điệp khúc). Có ${clips.length} clip (đánh số, kèm thời lượng, mô tả, từ khoá, mức sôi động 1–5).
Hãy chọn clip cho TỪNG câu hát.

Quy tắc:
- lines: mảng đúng ${lines.length} phần tử; phần tử thứ i = {"clip": số clip (1..${clips.length})} cho câu i.
- Ưu tiên khớp NỘI DUNG lời với mô tả / từ khoá clip (con vật, nhân vật, hành động, đồ vật, nơi chốn). Câu không có hình ảnh cụ thể thì chọn clip hợp không khí và nối mạch với câu trước.
- intro: số clip cho đoạn nhạc dạo trước câu 1 (clip tổng quan, gây chú ý).
- outro: số clip cho đoạn nhạc dạo sau câu cuối tới hết bài (${outroLen > 0.5 ? `dài ${outroLen.toFixed(1)} giây` : 'bài này gần như không có, vẫn chọn 1 clip'}; clip kết thúc êm, vẫy tay chào / cả nhà vui vẻ).
- Câu cùng nhóm [ĐK n] dùng lại đúng clip đã chọn cho lần đầu để bé dễ nhận ra điệp khúc.
- Đoạn điệp khúc / sôi động: ưu tiên clip mức sôi động cao; đoạn chậm, êm: clip mức thấp.
- Đa dạng: tránh một clip lặp lại quá 2 câu liền nhau, trừ khi lời đang tả đúng cảnh đó. Dùng hết các clip phù hợp; clip không hợp chủ đề bài hát thì bỏ.
- unused: số các clip không dùng.
- notes: 1–2 câu tiếng Việt tóm tắt cách xếp.
Chỉ trả về JSON {"intro": n, "outro": n, "lines": [{"clip": n}], "unused": [...], "notes": "..."}.

CLIP:
${clips.map((c, i) => `${i + 1}. [${String(p.clipNames[c.f] || '').slice(0, 80)}] ${c.kind === 'video' ? c.dur.toFixed(1) + 's' : 'ảnh tĩnh'} · sôi động ${c.energy || '?'} · ${c.mood || ''} · ${c.desc || '(chưa có mô tả)'}${c.tags?.length ? ' · từ khoá: ' + c.tags.join(', ') : ''}`).join('\n')}

LỜI BÀI HÁT:
${lines.map((l, i) => `${i + 1}. [${l.start.toFixed(1)}–${l.end.toFixed(1)}]${groups[i] ? ` [ĐK ${groups[i]}]` : ''} ${l.text}`).join('\n')}`;
  const r = await Vision.ask(settings, { prompt, schema: ARRANGE_SCHEMA, maxTokens: 16000, timeoutMs: 300000 }, signal);
  const n = clips.length;
  const idx = (v) => {
    v = Number(v);
    return Number.isInteger(v) && v >= 1 && v <= n ? p.clips[v - 1] : null;
  };
  const raw = Array.isArray(r.data?.lines) ? r.data.lines : [];
  const cur = load(id);
  if (cur.lines.length !== lines.length) throw httpError(409, 'Bảng câu hát đã đổi trong lúc AI đang xếp — hãy bấm xếp lại.');
  const out = cur.lines.map((l, i) => ({ ...l, clip: idx(raw[i]?.clip) }));
  // câu thiếu clip -> dùng clip của câu trước (hoặc câu sau ở đầu)
  for (let i = 0; i < out.length; i++) if (!out[i].clip && i > 0) out[i] = { ...out[i], clip: out[i - 1].clip };
  for (let i = out.length - 1; i >= 0; i--) if (!out[i].clip && i < out.length - 1) out[i] = { ...out[i], clip: out[i + 1].clip };
  cur.lines = normalizeLines(out, cur.clips);
  cur.introClip = idx(r.data?.intro) || cur.lines[0]?.clip || null;
  cur.outroClip = idx(r.data?.outro) || null;
  const used = new Set([cur.introClip, cur.outroClip, ...cur.lines.map((l) => l.clip)].filter(Boolean));
  cur.arrange = { notes: String(r.data?.notes || '').slice(0, 500), model: r.model, provider: r.provider, at: new Date().toISOString(), missingDesc: missing, unused: cur.clips.filter((f) => !used.has(f)), fixed: raw.length !== lines.length };
  persist(cur);
  return cur;
}

// ---------- AI chấm nhịp: nghe bài hát -> thời gian từng câu ----------
// Chỉ Gemini nhận được file âm thanh (Claude chỉ xem ảnh / đọc chữ) -> luôn dùng key + model Gemini trong Cài đặt.
const GEMINI_BASE = (process.env.GVA_GEMINI_BASE || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');

/** Bài hát -> mp3 mono 16kHz 48kbps (3 phút ≈ 1MB) để gửi kèm yêu cầu. */
async function songForAi(settings, song, out, signal) {
  await FF.run(settings.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', song, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', out], { signal });
  return fs.readFileSync(out);
}

async function geminiAudio(settings, { prompt, audio, signal }) {
  const key = settings.geminiKey;
  if (!key) throw httpError(400, 'AI chấm nhịp cần nghe bài hát — chỉ Gemini làm được. Vào Cài đặt → AI, nhập API key Gemini.');
  const model = settings.aiModelGemini;
  if (!model) throw httpError(400, 'Chưa chọn model Gemini — vào Cài đặt → AI, chọn Gemini rồi chọn model.');
  const body = {
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'audio/mp3', data: audio.toString('base64') } }, { text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  };
  let res;
  try {
    const sig = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(300000)]);
    res = await fetch(`${GEMINI_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: sig });
  } catch (e) {
    if (signal?.aborted) throw httpError(499, 'Đã dừng');
    throw httpError(502, `Gemini: không kết nối được (${e.name === 'TimeoutError' ? 'quá thời gian chờ' : e.message})`);
  }
  const text = await res.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch (_) {}
  if (!res.ok) throw httpError(res.status === 401 || res.status === 403 ? 400 : 502, `Gemini ${res.status}: ${j?.error?.message || text.slice(0, 300)}`);
  if (j?.promptFeedback?.blockReason) throw httpError(502, 'Gemini chặn yêu cầu này: ' + j.promptFeedback.blockReason);
  const out = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  const m = /\{[\s\S]*\}/.exec(out);
  try {
    return { data: JSON.parse(m ? m[0] : out), model };
  } catch (_) {
    throw httpError(502, 'Gemini trả về không đúng định dạng: ' + out.slice(0, 200));
  }
}

/** "1:05.3" | "65.3" | 65.3 -> giây */
const secOf = (v) => {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const m = /^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(String(v ?? ''));
  return m ? Number(m[1] || 0) * 60 + Number(m[2]) : null;
};

/**
 * AI nghe bài hát và chấm thời gian bắt đầu / kết thúc cho từng câu trong bảng câu hát.
 * Kết quả được kiểm tra: tăng dần, nằm trong bài; câu AI không chắc -> để trống (app chia đều khi dựng).
 */
async function aiAlign(id, settings, signal) {
  const p = load(id);
  if (!p.song) throw httpError(400, 'Hãy tải bài hát trước.');
  if (!p.lines.length) throw httpError(400, 'Chưa có lời bài hát — dán lời rồi bấm “Đọc lời” trước.');
  const dir = mdir(id);
  const T = p.songDuration || (await FF.probeDuration(settings.ffprobePath, path.join(dir, p.song)));
  const tmp = path.join(dir, `ai_${crypto.randomBytes(3).toString('hex')}.mp3`);
  let audio;
  try {
    audio = await songForAi(settings, path.join(dir, p.song), tmp, signal);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const lines = p.lines.map((l) => l.text);
  const prompt = `[task: music-align] File âm thanh là một bài hát (thường là bài hát thiếu nhi tiếng Việt), dài ${T.toFixed(1)} giây. Dưới đây là lời bài hát gồm ${lines.length} câu, đánh số theo đúng thứ tự được hát.
Hãy nghe thật kỹ và cho biết, với TỪNG câu, thời điểm giọng hát (hoặc giọng nói) BẮT ĐẦU câu đó và KẾT THÚC câu đó, tính bằng giây từ đầu file, 2 chữ số thập phân.

Quy tắc:
- lines: mảng đúng ${lines.length} phần tử, phần tử thứ i ứng với câu i: {"n": i, "start": giây, "end": giây}.
- start là lúc âm tiết ĐẦU TIÊN của câu bắt đầu được hát (không phải lúc nhạc dạo / tiếng nhạc bắt đầu). end là lúc âm tiết cuối kết thúc.
- Thời gian tăng dần theo thứ tự câu, không chồng lên nhau, nằm trong 0–${T.toFixed(1)}.
- Câu giống hệt nhau (điệp khúc hát lại) là những lần hát KHÁC nhau theo thứ tự — đừng gán cùng một thời điểm.
- Câu không nghe thấy được hát trong file: start = null, end = null.
- notes: 1 câu tiếng Việt (ví dụ đoạn nào khó nghe, lời trong file khác lời đã cho).
Chỉ trả về JSON {"lines": [{"n": 1, "start": 12.34, "end": 15.6}], "notes": "..."}.

LỜI:
${lines.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
  const r = await geminiAudio(settings, { prompt, audio, signal });
  const raw = Array.isArray(r.data?.lines) ? r.data.lines : [];
  // ưu tiên ghép theo số câu "n"; thiếu thì theo vị trí
  const byN = new Map(raw.filter((x) => Number.isInteger(Number(x?.n))).map((x) => [Number(x.n), x]));
  const times = lines.map((_, i) => {
    const x = byN.get(i + 1) || raw[i] || {};
    let start = secOf(x.start);
    let end = secOf(x.end);
    if (start === null || start < 0 || start >= T) return { start: null, end: null };
    if (end === null || end <= start || end > T + 0.5) end = null;
    return { start: Math.round(start * 100) / 100, end: end === null ? null : Math.round(Math.min(end, T) * 100) / 100 };
  });
  // tăng dần: câu nào lùi về trước câu đã chấm thì bỏ (để trống)
  let last = -1;
  let dropped = 0;
  for (const t of times) {
    if (t.start === null) continue;
    if (t.start <= last) {
      t.start = t.end = null;
      dropped++;
      continue;
    }
    last = t.start;
  }
  // kết thúc không được đè lên câu sau
  for (let i = 0; i < times.length; i++) {
    const next = times.slice(i + 1).find((t) => t.start !== null);
    if (times[i].end !== null && next && times[i].end > next.start) times[i].end = next.start;
  }
  const cur = load(id);
  if (cur.lines.length !== lines.length) throw httpError(409, 'Bảng câu hát đã đổi trong lúc AI đang nghe — hãy bấm chấm lại.');
  cur.lines = cur.lines.map((l, i) => ({ ...l, start: times[i].start, end: times[i].end }));
  const ok = times.filter((t) => t.start !== null).length;
  cur.align = { notes: String(r.data?.notes || '').slice(0, 500), model: r.model, at: new Date().toISOString(), timed: ok, total: lines.length, dropped };
  persist(cur);
  return cur;
}

/**
 * AI nghe bài hát, tự CHÉP LỜI và chấm thời gian từng câu (không cần dán lời).
 * Thay toàn bộ bảng câu hát; nếu đã có clip thì gán clip tự động (không AI) để dựng được ngay.
 */
async function aiTranscribe(id, settings, signal, opts = {}) {
  const p = load(id);
  if (!p.song) throw httpError(400, 'Hãy tải bài hát trước.');
  const dir = mdir(id);
  const T = p.songDuration || (await FF.probeDuration(settings.ffprobePath, path.join(dir, p.song)));
  const tmp = path.join(dir, `ai_${crypto.randomBytes(3).toString('hex')}.mp3`);
  let audio;
  try {
    audio = await songForAi(settings, path.join(dir, p.song), tmp, signal);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const prompt = `[task: music-transcribe] File âm thanh là một bài hát (thường là bài hát thiếu nhi tiếng Việt), dài ${T.toFixed(1)} giây. Hãy nghe thật kỹ và CHÉP LẠI LỜI bài hát kèm thời gian, để làm phụ đề karaoke.

Quy tắc:
- lines: mỗi phần tử là MỘT câu hát như một dòng trên bản lời bài hát (thường 4–10 chữ; tách câu ở chỗ ngắt hơi / hết một câu nhạc), theo đúng thứ tự: {"text": "...", "start": giây, "end": giây} — 2 chữ số thập phân, tính từ đầu file.
- Viết đúng chính tả tiếng Việt có dấu, viết hoa chữ đầu câu, giữ dấu phẩy / chấm than cho tự nhiên. Không thêm nhãn như [Điệp khúc], (x2).
- Có câu nói (ví dụ lời dẫn mở đầu) thì chép luôn. Đoạn chỉ có nhạc thì bỏ qua; tiếng ngân không lời thì bỏ, trừ khi hát rõ thành chữ (ví dụ "La la la").
- Điệp khúc hát lại bao nhiêu lần thì chép bấy nhiêu lần, mỗi lần với thời gian của chính lần đó.
- start: lúc âm tiết ĐẦU TIÊN của câu bắt đầu được hát; end: lúc âm tiết cuối kết thúc. Thời gian tăng dần, không chồng nhau, nằm trong 0–${T.toFixed(1)}.
- title: tên bài hát nếu nghe được hoặc đoán chắc từ lời, không thì "".
- notes: 1 câu tiếng Việt (ví dụ đoạn nào nghe không rõ).
Chỉ trả về JSON {"title": "", "lines": [{"text": "...", "start": 1.23, "end": 3.45}], "notes": "..."}.`;
  const r = await geminiAudio(settings, { prompt, audio, signal });
  const raw = Array.isArray(r.data?.lines) ? r.data.lines : [];
  const lines = [];
  let last = -1;
  for (const x of raw
    .map((x) => ({ text: String(x?.text ?? '').replace(/\s+/g, ' ').replace(/^\[.*?\]\s*/, '').trim().slice(0, 300), start: secOf(x?.start), end: secOf(x?.end) }))
    .filter((x) => x.text && x.start !== null && x.start >= 0 && x.start < T)
    .sort((a, b) => a.start - b.start)) {
    if (x.start <= last) continue; // trùng / chồng thời gian: bỏ
    last = x.start;
    lines.push({ text: x.text, start: Math.round(x.start * 100) / 100, end: x.end !== null && x.end > x.start ? Math.round(Math.min(x.end, T) * 100) / 100 : null });
  }
  for (let i = 0; i + 1 < lines.length; i++) if (lines[i].end !== null && lines[i].end > lines[i + 1].start) lines[i].end = lines[i + 1].start;
  if (!lines.length) throw httpError(502, 'AI không nghe ra lời nào trong bài hát' + (r.data?.notes ? ': ' + String(r.data.notes).slice(0, 200) : '.'));

  const cur = load(id);
  const withClips = cur.clips.length ? autoAssign(lines.map((l) => ({ ...l, clip: null })), cur.clips) : lines.map((l) => ({ ...l, clip: null }));
  cur.lines = normalizeLines(withClips, cur.clips);
  cur.lyricsRaw = lines.map((l) => l.text).join('\n');
  cur.introClip = null;
  cur.outroClip = null;
  cur.arrange = null;
  const title = String(r.data?.title || '').trim().slice(0, 120);
  if (title && (!cur.title || cur.title === cur.songName.replace(/\.[^.]+$/, '').slice(0, 120))) cur.title = title;
  const notes = String(r.data?.notes || '').slice(0, 500);
  cur.align = { notes, model: r.model, at: new Date().toISOString(), timed: lines.length, total: lines.length, dropped: raw.length - lines.length, transcribed: true };
  persist(cur);
  if (opts.refine === false) return cur;

  // lần 2: đã có lời đúng -> nghe lại chỉ để chấm thời gian (chính xác hơn khi vừa chép vừa chấm)
  let res;
  try {
    res = await aiAlign(id, settings, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    cur.align.notes = (notes + ' (Chưa chấm lại được thời gian: ' + e.message.slice(0, 120) + ')').trim();
    persist(cur);
    return cur;
  }
  // câu lần 2 bỏ trống -> dùng thời gian lần 1 nếu vẫn đúng thứ tự
  const L = res.lines;
  for (let i = 0; i < L.length; i++) {
    if (L[i].start !== null || !lines[i]) continue;
    const prev = L.slice(0, i).reverse().find((l) => l.start !== null)?.start ?? -1;
    const next = L.slice(i + 1).find((l) => l.start !== null)?.start ?? Infinity;
    if (lines[i].start > prev && lines[i].start < next) {
      L[i].start = lines[i].start;
      L[i].end = lines[i].end !== null && lines[i].end <= next ? lines[i].end : null;
    }
  }
  res.align = { ...res.align, notes: notes || res.align.notes, timed: L.filter((l) => l.start !== null).length, transcribed: true };
  persist(res);
  return res;
}

// ---------- mốc các đoạn bài hát (Intro, Verse 1, Chorus 1…) ----------
const SECTION_NAMES = 'intro|verse|pre[- ]?chorus|chorus|final chorus|post[- ]?chorus|hook|refrain|bridge|break|drop|interlude|instrumental|solo|outro|ending|coda|dạo đầu|nhạc dạo|phiên khúc|lời|điệp khúc|đk|cầu nối|vĩ thanh|kết';
const SECTION_HEAD = new RegExp(`^(?:\\[([^\\]]{1,60})\\]|\\(((?:${SECTION_NAMES})[^)]{0,40})\\)|((?:${SECTION_NAMES})(?:\\s*\\d{1,2})?)\\s*:?)$`, 'i');
const STANDARD_SECTIONS = ['Intro', 'Verse 1', 'Chorus 1', 'Verse 2', 'Chorus 2', 'Bridge', 'Verse 3', 'Final Chorus', 'Outro'];

/** Nhãn gọn: "[Intro - spoken, cheerful]" -> "Intro", "ĐK:" -> "ĐK". */
const sectionLabel = (s) => String(s).split(/\s+[-–—|]\s+|[:,(]/)[0].replace(/\s+/g, ' ').trim().slice(0, 40);

/**
 * Lời có nhãn đoạn -> [{ label, lines: [câu…] }]. Không có nhãn nào -> [].
 * Nhãn lặp lại không đánh số (Chorus, Chorus…) được đánh số Chorus 1, Chorus 2…
 */
function parseSections(text) {
  const raw = String(text || '').replace(/\r/g, '').replace(/^﻿/, '').slice(0, 300000);
  const out = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    const t = line.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const m = SECTION_HEAD.exec(t);
    if (m && !/^\[\d{1,3}:\d{1,2}/.test(t) && !/^\[[a-z]{1,8}:/i.test(t)) {
      const label = sectionLabel(m[1] || m[2] || m[3]);
      if (label) {
        out.push((cur = { label, lines: [] }));
        continue;
      }
    }
    if (!cur) out.push((cur = { label: '', lines: [] })); // lời trước nhãn đầu tiên
    if (cur.lines.length < 200) cur.lines.push(t.replace(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g, '').trim().slice(0, 300));
  }
  if (!out.some((s) => s.label)) return [];
  const sections = out.filter((s) => s.label || s.lines.length).slice(0, 60);
  const key = (l) => l.toLocaleLowerCase('vi');
  const count = new Map();
  for (const s of sections) if (s.label && !/\d\s*$/.test(s.label)) count.set(key(s.label), (count.get(key(s.label)) || 0) + 1);
  const seen = new Map();
  for (const s of sections) {
    if (!s.label) s.label = 'Mở đầu';
    const k = key(s.label);
    if ((count.get(k) || 0) < 2) continue;
    seen.set(k, (seen.get(k) || 0) + 1);
    s.label = `${s.label} ${seen.get(k)}`;
  }
  return sections;
}

function normalizeSections(items, T) {
  const list = (Array.isArray(items) ? items : []).slice(0, 60).map((s) => ({
    label: String(s?.label || '').replace(/\s+/g, ' ').trim().slice(0, 40),
    start: num(s?.start),
    first: String(s?.first || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    lines: Math.max(0, Math.round(Number(s?.lines) || 0)),
  })).filter((s) => s.label);
  list.forEach((s, i) => {
    const next = list.slice(i + 1).find((x) => x.start !== null);
    s.end = s.start === null ? null : Math.round((next ? next.start : T || s.start) * 1000) / 1000;
  });
  return list;
}

/** Mốc đoạn lấy từ bảng câu hát đã chấm nhịp: câu đầu của mỗi đoạn khớp với câu nào trong bảng (theo thứ tự). */
function sectionsFromLines(sections, lines) {
  let ptr = 0;
  return sections.map((s) => {
    const want = s.lines[0] ? textKey(s.lines[0]) : '';
    if (!want) return null;
    for (let i = ptr; i < lines.length; i++) {
      const k = textKey(lines[i].text);
      if (lines[i].start !== null && k && (k === want || k.startsWith(want) || want.startsWith(k))) {
        ptr = i + 1;
        return lines[i].start;
      }
    }
    return null;
  });
}

const SECTIONS_SCHEMA_HINT = '{"sections": [{"n": 1, "label": "Intro", "start": 0, "first": ""}], "notes": "..."}';

/**
 * Tìm thời điểm bắt đầu của từng đoạn bài hát (Intro, Verse 1, Chorus 1…).
 * - Lời có nhãn đoạn: AI (Gemini) nghe bài và chấm mốc cho đúng các đoạn đó.
 * - Lời không có nhãn / không dán lời: AI tự chia bài theo cấu trúc chuẩn.
 * Đoạn AI không chắc mà câu đầu đã có trong bảng câu hát (đã chấm nhịp) -> lấy giờ của câu đó.
 */
async function aiSections(id, settings, signal) {
  const p = load(id);
  if (!p.song) throw httpError(400, 'Hãy tải bài hát trước.');
  const dir = mdir(id);
  const T = p.songDuration || (await FF.probeDuration(settings.ffprobePath, path.join(dir, p.song)));
  const given = parseSections(p.sectionLyrics);
  const auto = !given.length;
  const plain = auto ? String(p.sectionLyrics || '').trim() || p.lines.map((l) => l.text).join('\n') : '';

  const tmp = path.join(dir, `ai_${crypto.randomBytes(3).toString('hex')}.mp3`);
  let audio;
  try {
    audio = await songForAi(settings, path.join(dir, p.song), tmp, signal);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const common = `- start: giây (2 chữ số thập phân, tính từ đầu file) lúc đoạn đó BẮT ĐẦU. Đoạn có lời: lúc âm tiết đầu tiên của đoạn được hát (nếu đoạn có vài nhịp nhạc dẫn riêng ngay trước lời thì lấy lúc nhạc dẫn đó bắt đầu). Đoạn chỉ có nhạc (Intro, Outro, Instrumental…): lúc phần nhạc đó bắt đầu; Intro thường là 0.
- Mốc tăng dần, nằm trong 0–${T.toFixed(1)}. Đoạn lặp lại (Chorus 1, Chorus 2…) là những lần hát KHÁC nhau theo thứ tự.
- first: câu hát đầu tiên của đoạn ("" nếu đoạn chỉ có nhạc).
- notes: 1 câu tiếng Việt (ví dụ đoạn nào khó nghe, đoạn nào không có trong file).`;
  const prompt = auto
    ? `[task: music-sections] File âm thanh là một bài hát, dài ${T.toFixed(1)} giây. Hãy nghe thật kỹ và chia bài hát thành các ĐOẠN theo cấu trúc bài hát, rồi cho biết thời điểm bắt đầu của từng đoạn.

Quy tắc:
- sections: các đoạn theo đúng thứ tự trong bài: {"n": số thứ tự, "label": tên đoạn, "start": giây, "first": "..."}.
- label dùng các tên: ${STANDARD_SECTIONS.join(', ')} (thêm Pre-Chorus, Verse 4, Chorus 3, Instrumental… nếu bài có; bỏ đoạn bài không có). Đoạn điệp khúc cuối cùng gọi là "Final Chorus".
${common}
Chỉ trả về JSON ${SECTIONS_SCHEMA_HINT}.${plain ? `\n\nLỜI BÀI HÁT (chưa chia đoạn):\n${plain.slice(0, 20000)}` : ''}`
    : `[task: music-sections] File âm thanh là một bài hát, dài ${T.toFixed(1)} giây. Dưới đây là lời bài hát đã chia thành ${given.length} đoạn (đánh số, kèm tên đoạn và lời), theo đúng thứ tự được hát. Hãy nghe thật kỹ và cho biết thời điểm BẮT ĐẦU của TỪNG đoạn.

Quy tắc:
- sections: mảng đúng ${given.length} phần tử, phần tử thứ i ứng với đoạn i: {"n": i, "label": tên đoạn như đã cho, "start": giây, "first": "..."}.
- Đoạn không nghe thấy trong file: start = null.
${common}
Chỉ trả về JSON ${SECTIONS_SCHEMA_HINT}.

CÁC ĐOẠN:
${given.map((s, i) => `${i + 1}. [${s.label}]\n${s.lines.length ? s.lines.slice(0, 40).join('\n') : '(chỉ có nhạc, không lời)'}`).join('\n\n')}`;
  const r = await geminiAudio(settings, { prompt, audio, signal });
  const raw = Array.isArray(r.data?.sections) ? r.data.sections : [];

  let items;
  if (auto) {
    items = raw.map((x) => ({ label: sectionLabel(x?.label || ''), start: secOf(x?.start), first: String(x?.first || ''), lines: 0 })).filter((x) => x.label);
  } else {
    const byN = new Map(raw.filter((x) => Number.isInteger(Number(x?.n))).map((x) => [Number(x.n), x]));
    const fromLines = sectionsFromLines(given, p.lines);
    items = given.map((s, i) => {
      const x = byN.get(i + 1) || raw[i] || {};
      return { label: s.label, start: secOf(x.start), fallback: fromLines[i], first: s.lines[0] || '', lines: s.lines.length };
    });
  }
  // mốc phải nằm trong bài + tăng dần; mốc lỗi -> thử lấy từ bảng câu hát, không được thì để trống
  let last = -1;
  let dropped = 0;
  for (const s of items) {
    const okT = (t) => t !== null && t !== undefined && t >= 0 && t < T && t > last;
    if (!okT(s.start)) {
      if (s.start !== null && s.start !== undefined) dropped++;
      s.start = okT(s.fallback) ? s.fallback : null;
    }
    if (s.start !== null) {
      s.start = Math.round(s.start * 100) / 100;
      last = s.start;
    }
    delete s.fallback;
  }
  if (auto && !items.length) throw httpError(502, 'AI không chia được đoạn nào' + (r.data?.notes ? ': ' + String(r.data.notes).slice(0, 200) : '.'));

  const cur = load(id);
  cur.sections = {
    items: normalizeSections(items, T),
    auto,
    notes: String(r.data?.notes || '').slice(0, 500),
    model: r.model,
    at: new Date().toISOString(),
    dropped,
  };
  persist(cur);
  return cur;
}

// ---------- dựng ----------
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

/**
 * Filtergraph đặt một clip video vào khung W x H (phủ kín / trọn clip + nền mờ / trọn clip + nền màu).
 * delogo: { w, h, marks } kích thước gốc của clip + các logo dò được -> xoá logo Gemini trước khi co giãn.
 */
function clipFilter({ W, H, fit, bgColor, fps, dur, fade, delogo }) {
  const pre = delogo ? `[0:v]${Watermark.filter(delogo.w, delogo.h, delogo.marks)}[src];` : '';
  const src = delogo ? '[src]' : '[0:v]';
  let g;
  if (fit === 'cover') g = `${pre}${src}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
  else if (fit === 'color') {
    const c = /^#[0-9a-f]{6}$/i.test(bgColor || '') ? '0x' + bgColor.slice(1) : '0xffffff';
    g = `${pre}color=c=${c}:s=${W}x${H}:r=${fps}[bg];${src}scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1`;
  } else {
    g =
      `${pre}${src}split=2[a][b];` +
      `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},scale=iw/12:ih/12,boxblur=5:2,scale=${W}:${H},eq=brightness=-0.08[bg];` +
      `[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1`;
  }
  // clip hết trước khi cảnh hết -> giữ khung hình cuối
  g += `,fps=${fps},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${(dur + 1).toFixed(2)},format=yuv420p`;
  if (fade && dur > 1) g += `,fade=t=in:st=0:d=0.2,fade=t=out:st=${(dur - 0.2).toFixed(3)}:d=0.2`;
  return g;
}

async function runRender(p, settings, signal) {
  const o = p.options;
  const dir = mdir(p.id);
  const song = path.join(dir, p.song);
  const work = path.join(dir, 'work');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  const { w: W, h: H } = FF.resolutionFor(o);
  const fps = o.fps;
  const T = await FF.probeDuration(settings.ffprobePath, song);
  if (o.cutOnBeat && !p.beats) {
    p.message = 'Dò nhịp bài hát…';
    try {
      p.beats = await Beats.detect(settings.ffmpegPath, song, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      log(p, 'Không dò được nhịp: ' + e.message);
    }
  }
  if (p.beats?.bpm) log(p, `Nhịp bài hát ~${Math.round(p.beats.bpm)} BPM${o.cutOnBeat ? ', cắt cảnh đúng phách' : ''}.`);
  const lines = timeLines(p.lines, T);
  const guessed = lines.filter((l) => l.guess).length;
  if (guessed) log(p, `${guessed}/${lines.length} câu chưa có thời gian -> chia đều tạm. Nên chấm nhịp để lời khớp với giọng hát.`);
  const shots = planShots(p, lines, T);
  const nVid = p.clips.filter((f) => p.clipInfo[f]?.kind === 'video').length;
  log(p, `Dựng ${W}x${H} @${fps}fps, bài hát ${T.toFixed(1)}s, ${lines.length} câu, ${shots.length} cảnh, dùng ${new Set(shots.map((s) => s.file)).size}/${p.clips.length} asset (${nVid} clip video).`);

  const fb = shots.map((s) => Math.round(s.start * fps));
  fb.push(Math.round(T * fps));
  const segs = [];
  for (let i = 0; i < shots.length; i++) {
    const F = Math.max(1, fb[i + 1] - fb[i]);
    const dur = F / fps;
    const sh = shots[i];
    const inf = p.clipInfo[sh.file] || { kind: 'image' };
    const src = clipPath(p.id, sh.file);
    const out = path.join(work, `seg_${String(i).padStart(4, '0')}.mp4`);
    p.message = `Dựng cảnh ${i + 1}/${shots.length}…`;
    let args;
    if (inf.kind === 'video') {
      const delogo = o.removeWatermark ? { w: inf.w, h: inf.h, marks: await clipMarks(settings, src, inf) } : null;
      const g = clipFilter({ W, H, fit: o.fit, bgColor: o.bgColor, fps, dur, fade: o.transition === 'fade', delogo });
      args = ['-ss', sh.from.toFixed(3), '-i', src, '-filter_complex', g];
    } else {
      const g = FF.sceneFilter({ W, H, fit: o.fit, bgColor: o.bgColor, kind: FF.effectFor(o.motion, i), strength: o.strength, F, fps, fade: o.transition === 'fade', dur, fx: null });
      args = ['-i', src, '-filter_complex', g];
    }
    await FF.run(
      settings.ffmpegPath,
      ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', ...args, '-frames:v', String(F), '-r', String(fps), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-an', out],
      { signal, onTime: (t) => progress(p, ((i + Math.min(1, t / dur)) / shots.length) * 75) },
    );
    segs.push(out);
    progress(p, ((i + 1) / shots.length) * 75, `Dựng cảnh ${i + 1}/${shots.length}`);
  }

  p.message = 'Ghép cảnh…';
  fs.writeFileSync(path.join(work, 'list.txt'), segs.map((f) => `file '${path.basename(f)}'`).join('\n'));
  const joined = path.join(work, 'joined.mp4');
  await FF.run(settings.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(work, 'list.txt'), '-c', 'copy', joined], { signal });
  progress(p, 76);

  // tiếng của clip (khi không tắt): cắt đúng đoạn từng cảnh, cảnh không có tiếng thì để im lặng, rồi nối lại
  let clipAudio = null;
  if (!o.muteClips) {
    for (const f of new Set(shots.map((sh) => sh.file))) {
      const inf = p.clipInfo[f];
      if (inf?.kind === 'video' && inf.audio === undefined) inf.audio = await hasAudio(settings, clipPath(p.id, f));
    }
    if (shots.some((sh) => p.clipInfo[sh.file]?.audio)) {
      p.message = 'Lấy tiếng của clip…';
      const parts = [];
      for (let i = 0; i < shots.length; i++) {
        const dur = Math.max(1, fb[i + 1] - fb[i]) / fps;
        const sh = shots[i];
        const out = path.join(work, `aud_${String(i).padStart(4, '0')}.wav`);
        const fmt = ['-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', '-t', dur.toFixed(4), out];
        if (p.clipInfo[sh.file]?.audio) {
          const fo = Math.max(0, dur - 0.04).toFixed(3);
          await FF.run(settings.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', sh.from.toFixed(3), '-i', clipPath(p.id, sh.file), '-map', '0:a:0', '-af', `aresample=48000,apad,afade=t=in:d=0.03,afade=t=out:st=${fo}:d=0.04`, ...fmt], { signal });
        } else await FF.run(settings.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', ...fmt], { signal });
        parts.push(out);
      }
      fs.writeFileSync(path.join(work, 'alist.txt'), parts.map((f) => `file '${path.basename(f)}'`).join('\n'));
      clipAudio = path.join(work, 'clipaudio.wav');
      await FF.run(settings.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(work, 'alist.txt'), '-c', 'copy', clipAudio], { signal });
      log(p, `Giữ tiếng clip (âm lượng ${Math.round(o.clipVolume * 100)}%) trộn dưới bài hát.`);
    } else log(p, 'Các clip đang dùng không có tiếng — chỉ có bài hát.');
  }
  progress(p, 78);

  // video intro / outro: đưa về đúng khung W x H, fps; tiếng 48kHz stereo (không có tiếng thì im lặng) để nối vào đầu / cuối video
  const prepBumper = async (k) => {
    const b = getBumper(k);
    if (!b) throw httpError(400, `Chưa có video ${k}. Hãy tải video ${k} trước khi dựng.`);
    p.message = `Chuẩn bị video ${k}…`;
    const nF = Math.max(1, Math.round(b.dur * fps));
    const v = path.join(work, `${k}_v.mp4`);
    const a = path.join(work, `${k}_a.wav`);
    const src = path.join(BUMPER_DIR[k], b.file);
    await FF.run(
      settings.ffmpegPath,
      ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-filter_complex', clipFilter({ W, H, fit: o.fit, bgColor: o.bgColor, fps, dur: nF / fps, fade: false }), '-frames:v', String(nF), '-r', String(fps), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-an', v],
      { signal },
    );
    const aFmt = ['-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', '-t', (nF / fps).toFixed(4), a];
    if (b.audio) await FF.run(settings.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-map', '0:a:0', '-af', 'aresample=48000,apad', ...aFmt], { signal });
    else await FF.run(settings.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', ...aFmt], { signal });
    return { ...b, v, a, len: nF / fps };
  };
  const intro = await prepBumper('intro');
  const iOff = intro.len;
  log(p, `Nối video intro "${intro.name}" (${iOff.toFixed(1)}s) vào đầu video.`);
  progress(p, 79);
  const outro = await prepBumper('outro');
  log(p, `Nối video outro "${outro.name}" (${outro.len.toFixed(1)}s) vào cuối video.`);
  progress(p, 80);

  // font đi kèm app: chép vào thư mục dựng để libass tìm thấy (ass=…:fontsdir=fonts)
  fs.mkdirSync(path.join(work, 'fonts'), { recursive: true });
  for (const f of CAPTION_FONTS) if (f.file) fs.copyFileSync(path.join(FONTS_DIR, f.file), path.join(work, 'fonts', f.file));
  if (o.titleIntro) log(p, `Hiện tên bài "${p.introTitle.trim()}" lúc nhạc dạo.`);
  fs.writeFileSync(path.join(work, 'lyrics.ass'), buildAss({ lines, scenes: shots, clipFx: p.clipFx, o, W, H, title: p.introTitle.trim(), T }));
  const aChain = o.normalizeAudio ? 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000' : 'aresample=48000';
  // lời + hiệu ứng chỉ đốt lên phần bài hát (giữ đúng thời gian), rồi nối intro vào trước, outro vào sau cả hình lẫn tiếng.
  // -reinit_filter 0: cảnh ảnh / cảnh video có thông số màu khác nhau -> ffmpeg dựng lại bộ lọc giữa chừng, concat bị reset và mất hình
  const iIn = clipAudio ? 3 : 2;
  const audioGraph = clipAudio
    ? `[1:a]aresample=48000[song];[2:a]volume=${o.clipVolume.toFixed(2)},aresample=48000[clips];[song][clips]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,${aChain},atrim=0:${T.toFixed(3)}[am]`
    : `[1:a]${aChain},atrim=0:${T.toFixed(3)}[am]`;
  // logo kênh ở góc, chỉ trên phần bài hát (không có trong intro / outro); lời karaoke vẽ đè lên logo
  const logo = getLogo();
  if (!logo) throw httpError(400, 'Chưa có logo kênh. Hãy tải logo trước khi dựng.');
  let logoIn = [];
  let vBase = '[0:v]';
  if (logo) {
    const lw = Math.max(2, Math.round((W * logo.size) / 2) * 2);
    const mg = Math.round(Math.min(W, H) * 0.03);
    const x = logo.position.endsWith('l') ? `${mg}` : `W-w-${mg}`;
    const y = logo.position.startsWith('t') ? `${mg}` : `H-h-${mg}`;
    logoIn = ['-i', path.join(LOGO_DIR, logo.file)];
    vBase = `[${iIn + 4}:v]scale=${lw}:-2:flags=lanczos,format=rgba${logo.opacity < 1 ? `,colorchannelmixer=aa=${logo.opacity.toFixed(2)}` : ''}[lg];[0:v][lg]overlay=x=${x}:y=${y}:format=auto,format=yuv420p,`;
    log(p, `Gắn logo "${logo.name}" ở góc ${{ tr: 'trên phải', tl: 'trên trái', br: 'dưới phải', bl: 'dưới trái' }[logo.position]} (rộng ${lw}px).`);
  }
  const graph = `${vBase}ass=lyrics.ass:fontsdir=fonts,trim=0:${T.toFixed(3)},setpts=PTS-STARTPTS,setsar=1[vm];[${iIn}:v]setsar=1[vi];[${iIn + 2}:v]setsar=1[vo];[vi][vm][vo]concat=n=3:v=1:a=0[v];${audioGraph};[${iIn + 1}:a]aformat=sample_rates=48000:channel_layouts=stereo[ai];[${iIn + 3}:a]aformat=sample_rates=48000:channel_layouts=stereo[ao];[ai][am][ao]concat=n=3:v=0:a=1[a]`;
  const total = iOff + T + outro.len;
  const final = path.join(work, 'final.mp4');
  p.message = 'Ghép intro + bài hát + lời karaoke + hiệu ứng + outro…';
  await FF.run(
    settings.ffmpegPath,
    ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-reinit_filter', '0', '-i', joined, '-i', song, ...(clipAudio ? ['-i', clipAudio] : []), '-i', intro.v, '-i', intro.a, '-i', outro.v, '-i', outro.a, ...logoIn, '-filter_complex', graph, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(fps), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-t', total.toFixed(3), '-movflags', '+faststart', final],
    { cwd: work, signal, onTime: (t) => progress(p, 80 + Math.min(1, t / total) * 20) },
  );

  // file video đặt theo tên video (mục Khổ video); xoá file của lần dựng trước nếu tên khác
  const outName = videoFileName(p.title) || 'output.mp4';
  for (const f of new Set([videoFile(p), 'output.mp4'])) if (f !== outName) fs.rmSync(path.join(dir, f), { force: true });
  fs.renameSync(final, path.join(dir, outName));
  p.files.videoFile = outName;
  // lời đã chấm nhịp: tải về dùng lại (YouTube nhận cả SRT) — SRT đi kèm video nên dời sau phần intro
  fs.writeFileSync(path.join(dir, 'lyrics.srt'), S.buildSrt(S.shiftCues(lines, iOff)));
  fs.writeFileSync(path.join(dir, 'lyrics.lrc'), (p.title ? `[ti:${p.title}]\n` : '') + lines.map((l) => `[${fmtLrc(l.start)}]${l.text}`).join('\n') + '\n');
  p.videoDuration = await FF.probeDuration(settings.ffprobePath, path.join(dir, outName));
  p.files.video = true;
  fs.rmSync(work, { recursive: true, force: true });
  log(p, `Xong video nhạc ${p.videoDuration.toFixed(1)}s (${(fs.statSync(path.join(dir, outName)).size / 1048576).toFixed(1)} MB) → ${outName}`);
  progress(p, 100, 'Đã tạo video nhạc');
}

function start(reqId, data) {
  const p = load(reqId);
  if (p.status === 'queued' || p.status === 'running') throw httpError(409, 'Dự án đang chạy, hãy chờ hoặc huỷ trước.');
  if (data) applyData(p, data);
  if (!p.name) throw httpError(400, 'Chưa có tên dự án. Hãy nhập Tên dự án ở đầu trang — thư mục dự án sẽ đặt theo tên này.');
  if (!videoFileName(p.title)) throw httpError(400, 'Chưa có tên video. Hãy nhập Tên video (mục Khổ video) — file video xuất ra sẽ lấy theo tên này.');
  if (!p.song || !fs.existsSync(path.join(mdir(p.id), p.song))) throw httpError(400, 'Hãy tải bài hát (file nhạc) trước.');
  if (!p.clips.length) throw httpError(400, 'Hãy tải ít nhất 1 clip video (hoặc ảnh).');
  if (!p.lines.length && p.options.captions.on) throw httpError(400, 'Chưa có lời bài hát. Dán lời rồi bấm “Đọc lời”, hoặc tắt phụ đề.');
  if (!getIntro()) throw httpError(400, 'Chưa có video intro. Hãy tải video intro (mục 1) trước khi dựng.');
  if (!getOutro()) throw httpError(400, 'Chưa có video outro. Hãy tải video outro (mục 2) trước khi dựng.');
  if (!getLogo()) throw httpError(400, 'Chưa có logo kênh. Hãy tải logo (mục 3) trước khi dựng.');
  if (!p.introTitle?.trim()) throw httpError(400, 'Chưa nhập tên bài hiện lúc nhạc dạo (mục Hình & chữ) — ô này bắt buộc.');
  moveDir(p);
  const id = p.id;

  Object.assign(p, { status: 'queued', job: 'video', error: '', progress: 0, startedAt: null, finishedAt: null, message: 'Đang chờ trong hàng đợi…' });
  persist(p);
  const ac = new AbortController();
  controllers.set(id, ac);
  queue = queue.then(async () => {
    if (ac.signal.aborted) return;
    p.status = 'running';
    p.startedAt = new Date().toISOString();
    persist(p);
    try {
      if (p.files.video) {
        fs.rmSync(path.join(mdir(id), videoFile(p)), { force: true });
        p.files.video = false;
      }
      await runRender(p, cfg.getSettings(), ac.signal);
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
      fs.rmSync(path.join(mdir(id), 'work'), { recursive: true, force: true });
      persist(p);
    }
  });
  return p;
}

function cancel(id) {
  const p = load(id);
  controllers.get(id)?.abort();
  if (p.status === 'queued') {
    p.status = 'canceled';
    p.message = 'Đã huỷ';
    persist(p);
  }
  return p;
}

// Server khởi động lại: tác vụ dở dang coi như lỗi.
for (const id of fs.readdirSync(ROOT)) {
  if (!isId(id)) continue;
  try {
    const p = load(id);
    if (p.status === 'queued' || p.status === 'running') {
      p.status = 'error';
      p.error = 'Server đã khởi động lại giữa chừng, hãy chạy lại.';
      persist(p);
    }
    fs.rmSync(path.join(mdir(id), 'work'), { recursive: true, force: true });
  } catch (_) {}
}


module.exports = {
  KIDS_FX,
  CAPTION_PRESETS,
  CAPTION_FONTS,
  create,
  load,
  list,
  remove,
  publicProject,
  applyData,
  removeClip,
  removeClips,
  assetTarget,
  registerAsset,
  parseLyrics,
  parseSections,
  autoAssign,
  timeLines,
  planShots,
  buildAss,
  describeClip,
  aiArrange,
  aiAlign,
  aiTranscribe,
  aiSections,
  start,
  cancel,
  getBumper,
  bumperTarget,
  registerBumper,
  removeBumper,
  getIntro,
  getOutro,
  INTRO_DIR,
  INTRO_RE,
  OUTRO_DIR,
  OUTRO_RE,
  getLogo,
  logoTarget,
  registerLogo,
  updateLogo,
  removeLogo,
  LOGO_DIR,
  LOGO_RE,
  mdir,
  isId,
  videoFile,
  ID_RE,
  SONG_RE,
};
