'use strict';
// Máy chủ localhost, không cần thư viện ngoài (chỉ dùng module có sẵn của Node).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const cfg = require('./lib/config');
const pipeline = require('./lib/pipeline');
const FF = require('./lib/ffmpeg');
const { Genmax } = require('./lib/genmax');
const Vision = require('./lib/vision');
const FX = require('./lib/effects');
const S = require('./lib/srt');
const Prompts = require('./lib/prompts');
const Music = require('./lib/music');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1'; // chỉ nhận kết nối từ chính máy này
const PUBLIC = path.join(__dirname, 'public');
const MAX_ASSET = 80 * 1024 * 1024; // 80MB / file

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.srt': 'text/plain; charset=utf-8',
};

// ---------- tiện ích ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(pipeline.httpError(413, 'Nội dung gửi lên quá lớn'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (_) {
        reject(pipeline.httpError(400, 'JSON không hợp lệ'));
      }
    });
    req.on('error', reject);
  });
}

function serveFile(req, res, file, { download, name } = {}) {
  let st;
  try {
    st = fs.statSync(file);
    if (!st.isFile()) throw new Error('not file');
  } catch (_) {
    return sendJson(res, 404, { error: 'Không tìm thấy file' });
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name || path.basename(file))}`;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? parseInt(range[1], 10) : st.size - parseInt(range[2], 10);
    let end = range[1] && range[2] ? parseInt(range[2], 10) : st.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, st.size - 1);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

// ---------- bảo vệ: chỉ trang web của chính localhost mới được gọi API ----------
function guard(req) {
  const host = String(req.headers.host || '');
  const okHosts = [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`];
  if (!okHosts.includes(host)) throw pipeline.httpError(403, 'Host không hợp lệ');
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) throw pipeline.httpError(403, 'Origin không hợp lệ');
  if (req.method !== 'GET' && req.method !== 'HEAD' && !origin && req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') {
    throw pipeline.httpError(403, 'Yêu cầu chéo trang bị chặn');
  }
}

// ---------- router ----------
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z]+)/gi, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler });
}

route('GET', '/api/health', async () => {
  const s = cfg.getSettings();
  return { status: 200, body: { ffmpeg: await FF.check(s), node: process.version, dataDir: cfg.DATA } };
});

route('GET', '/api/settings', async () => ({ status: 200, body: cfg.publicSettings() }));
route('PUT', '/api/settings', async (req) => {
  cfg.saveSettings(await readJson(req));
  return { status: 200, body: cfg.publicSettings() };
});
// Kiểm tra key genmax: key/Base URL đang gõ (chưa lưu) nếu có, không thì key đã lưu
route('POST', '/api/settings/test', async (req) => {
  const b = await readJson(req);
  const saved = cfg.getSettings();
  const typed = typeof b.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : '';
  const s = { ...saved, apiKey: typed || saved.apiKey, baseUrl: typeof b.baseUrl === 'string' && b.baseUrl.trim() ? b.baseUrl.trim() : saved.baseUrl };
  if (!s.apiKey) return { status: 200, body: { ok: false, message: 'Chưa nhập API key.' } };
  return { status: 200, body: { ...(await new Genmax(s).testKey()), unsaved: !!typed } };
});

const providerOf = (query) => {
  const p = query.get('provider') || 'elevenlabs';
  if (!cfg.PROVIDERS.includes(p)) throw pipeline.httpError(400, 'Nhà cung cấp không hợp lệ');
  return p;
};

route('GET', '/api/credits', async () => {
  const s = cfg.getSettings();
  if (!s.apiKey) return { status: 200, body: { credits: null } };
  return { status: 200, body: { credits: await new Genmax(s).credits() } };
});
route('GET', '/api/models', async (req, params, query) => ({ status: 200, body: await new Genmax(cfg.getSettings()).models(providerOf(query)) }));
route('GET', '/api/languages', async (req, params, query) => ({ status: 200, body: await new Genmax(cfg.getSettings()).languages(providerOf(query)) }));

// Thư viện giọng: ?source=el-shared|el-default|mm-system|mm-cloned|cc-system + bộ lọc
const VOICE_FILTERS = ['search', 'page', 'pageSize', 'sort', 'category', 'gender', 'age', 'accent', 'language', 'useCase', 'emotion'];
route('GET', '/api/voices', async (req, params, query) => {
  const f = {};
  for (const k of VOICE_FILTERS) if (query.get(k)) f[k] = query.get(k).slice(0, 120);
  return { status: 200, body: await new Genmax(cfg.getSettings()).voiceLibrary(query.get('source') || 'el-default', f) };
});

// ---------- hiệu ứng + AI nhìn ảnh ----------
route('GET', '/api/effects', async () => ({ status: 200, body: FX.EFFECTS }));
// Kiểm tra key AI bằng lời gọi danh sách model (không tốn tiền)
// (key đang gõ, chưa lưu, được ưu tiên nếu có)
route('POST', '/api/ai/test', async (req, params, query) => {
  const b = await readJson(req);
  const saved = cfg.getSettings();
  const provider = query.get('provider') || saved.aiProvider;
  if (!Vision.PROVIDERS.includes(provider)) throw pipeline.httpError(400, 'Nhà cung cấp AI không hợp lệ');
  const name = Vision.PROVIDER_NAME[provider];
  const field = Vision.KEY_FIELD[provider];
  const typed = typeof b.key === 'string' && b.key.trim() ? b.key.trim() : '';
  const st = { ...saved, [field]: typed || saved[field] };
  if (!st[field]) return { status: 200, body: { ok: false, message: `Chưa nhập API key ${name}.` } };
  try {
    const list = await Vision.listModels(st, provider);
    return { status: 200, body: { ok: true, count: list.length, provider, unsaved: !!typed } };
  } catch (e) {
    return { status: 200, body: { ok: false, message: e.message } };
  }
});
route('GET', '/api/ai/models', async (req, params, query) => ({ status: 200, body: await Vision.listModels(cfg.getSettings(), query.get('provider') || cfg.getSettings().aiProvider) }));
// Gợi ý hiệu ứng: gửi thẳng nội dung ảnh (raw body)
route('POST', '/api/ai/suggest', async (req, params, query, res) => {
  // trình duyệt bấm Dừng -> kết nối đóng -> huỷ luôn lời gọi AI đang chạy
  const ac = new AbortController();
  res.on('close', () => !res.writableEnded && ac.abort());
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_ASSET) throw pipeline.httpError(413, 'Ảnh quá lớn (tối đa 80MB).');
    chunks.push(c);
  }
  if (!size) throw pipeline.httpError(400, 'Chưa gửi ảnh.');
  return { status: 200, body: await Vision.suggest(cfg.getSettings(), Buffer.concat(chunks), { force: query.get('force') === '1', signal: ac.signal }) };
});

// ---------- xếp ảnh theo kịch bản ----------
route('POST', '/api/story/blocks', async (req) => {
  const b = await readJson(req);
  return { status: 200, body: { blocks: S.storyBlocks(String(b.script || '').slice(0, 300000)).map((x) => x.text) } };
});
route('POST', '/api/ai/storyboard', async (req, params, query, res) => {
  const ac = new AbortController();
  res.on('close', () => !res.writableEnded && ac.abort());
  const b = await readJson(req, 4 * 1024 * 1024);
  const blocks = S.storyBlocks(String(b.script || '').slice(0, 300000)).map((x) => x.text);
  const images = (Array.isArray(b.images) ? b.images : []).slice(0, 400).map((im) => ({ name: String(im?.name || ''), desc: String(im?.desc || '') }));
  const r = await Vision.storyboard(cfg.getSettings(), { blocks, images }, ac.signal);
  return { status: 200, body: { blocks, ...r } };
});

// ---------- prompt tạo ảnh cho từng cảnh ----------
const abortOnClose = (res) => {
  const ac = new AbortController();
  res.on('close', () => !res.writableEnded && ac.abort());
  return ac.signal;
};
route('POST', '/api/prompts/style', async (req, params, query, res) => {
  const signal = abortOnClose(res);
  const b = await readJson(req, 4 * 1024 * 1024);
  const g = await Prompts.styleGuide(cfg.getSettings(), { script: b.script, userStyles: b.styles ?? b.style, aspect: b.aspect }, signal);
  return { status: 200, body: { ...g, texts: Prompts.scenesOf(b.script), batch: Prompts.BATCH } };
});
route('POST', '/api/prompts/scenes', async (req, params, query, res) => {
  const signal = abortOnClose(res);
  const b = await readJson(req, 4 * 1024 * 1024);
  return { status: 200, body: await Prompts.scenePrompts(cfg.getSettings(), { script: b.script, from: b.from, to: b.to, guide: b.guide, tool: b.tool, aspect: b.aspect }, signal) };
});

route('GET', '/api/favorites', async () => ({ status: 200, body: cfg.getFavorites() }));
route('PUT', '/api/favorites', async (req) => {
  const b = await readJson(req);
  return { status: 200, body: cfg.setFavorite(b.voice, !!b.on) };
});

route('GET', '/api/projects', async () => ({ status: 200, body: pipeline.list() }));
route('POST', '/api/projects', async () => ({ status: 200, body: pipeline.publicProject(pipeline.create()) }));
route('GET', '/api/projects/:id', async (req, { id }) => ({ status: 200, body: pipeline.publicProject(pipeline.load(id)) }));
route('DELETE', '/api/projects/:id', async (req, { id }) => {
  pipeline.remove(id);
  return { status: 200, body: { ok: true } };
});
// Mở thư mục dự án trong Finder (chọn sẵn video, hoặc giọng nếu chưa có video)
route('POST', '/api/projects/:id/reveal', async (req, { id }) => {
  const p = pipeline.load(id);
  const dir = pipeline.pdir(p.id);
  const file = [p.files.video && 'output.mp4', p.files.audio && 'voice.mp3'].filter(Boolean).map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', file ? ['-R', file] : [dir]]
      : process.platform === 'win32'
        ? ['explorer', [file ? '/select,' + file : dir]]
        : ['xdg-open', [dir]];
  await new Promise((resolve, reject) => execFile(cmd, args, (err) => (err && process.platform !== 'win32' ? reject(pipeline.httpError(500, 'Không mở được thư mục: ' + err.message)) : resolve())));
  return { status: 200, body: { ok: true, dir } };
});

route('POST', '/api/projects/:id/cancel', async (req, { id }) => ({ status: 200, body: pipeline.publicProject(pipeline.cancel(id)) }));

// Lưu form (không chạy gì)
route('PUT', '/api/projects/:id', async (req, { id }) => {
  const p = pipeline.load(id);
  pipeline.applyData(p, await readJson(req), cfg.getSettings());
  return { status: 200, body: pipeline.publicProject(p) };
});

// Chạy: body { action: 'voice' | 'video', data: {...form} }
route('POST', '/api/projects/:id/run', async (req, { id }) => {
  const body = await readJson(req);
  const p = pipeline.start(id, body.action, body.data);
  return { status: 200, body: pipeline.publicProject(p) };
});

// Tải ảnh / nhạc nền: gửi thẳng nội dung file (raw body), tên file trong query
route('POST', '/api/projects/:id/assets', async (req, { id }, query) => {
  const kind = query.get('kind') === 'bgm' ? 'bgm' : 'image';
  const orig = query.get('name') || '';
  const { file, full } = pipeline.assetTarget(id, kind, orig);
  const declared = Number(req.headers['content-length']) || 0;
  if (declared > MAX_ASSET) throw pipeline.httpError(413, 'File quá lớn (tối đa 80MB).');
  const tmp = full + '.part';
  await new Promise((resolve, reject) => {
    let size = 0;
    const out = fs.createWriteStream(tmp);
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_ASSET) {
        out.destroy();
        req.destroy();
        reject(pipeline.httpError(413, 'File quá lớn (tối đa 80MB).'));
      }
    });
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    req.on('error', reject);
  }).catch((e) => {
    fs.rmSync(tmp, { force: true });
    throw e;
  });
  fs.renameSync(tmp, full);
  pipeline.registerAsset(id, kind, file, orig);
  return { status: 200, body: { file, name: orig } };
});

// ---------- video nhạc (tách riêng khỏi dự án "Tạo video") ----------
const MAX_CLIP = 600 * 1024 * 1024; // clip video cho video nhạc: 600MB / file

/** Ghi body của request ra file (qua file .part), tối đa max byte. */
async function saveUpload(req, full, max = MAX_ASSET) {
  const tooBig = () => pipeline.httpError(413, `File quá lớn (tối đa ${Math.round(max / 1048576)}MB).`);
  if ((Number(req.headers['content-length']) || 0) > max) throw tooBig();
  const tmp = full + '.part';
  await new Promise((resolve, reject) => {
    let size = 0;
    const out = fs.createWriteStream(tmp);
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        out.destroy();
        req.destroy();
        reject(tooBig());
      }
    });
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    req.on('error', reject);
  }).catch((e) => {
    fs.rmSync(tmp, { force: true });
    throw e;
  });
  fs.renameSync(tmp, full);
}

route('GET', '/api/music/meta', async () => ({ status: 200, body: { effects: Music.KIDS_FX, presets: Music.CAPTION_PRESETS, fonts: Music.CAPTION_FONTS } }));
route('POST', '/api/music/lyrics', async (req) => ({ status: 200, body: Music.parseLyrics((await readJson(req, 4 * 1024 * 1024)).text) }));
route('POST', '/api/music/assign', async (req) => {
  const b = await readJson(req, 4 * 1024 * 1024);
  const clips = (Array.isArray(b.clips) ? b.clips : []).filter((f) => typeof f === 'string').slice(0, 400);
  const lines = (Array.isArray(b.lines) ? b.lines : []).slice(0, 2000).map((l) => ({ ...l, text: String(l?.text || '') }));
  return { status: 200, body: { lines: Music.autoAssign(lines, clips, { every: Math.max(0, Math.min(50, Number(b.every) || 0)), reuseRepeats: b.reuseRepeats !== false }) } };
});
// video intro / outro dùng chung: nối vào đầu / cuối mọi video nhạc (đăng ký trước /api/music/:id)
for (const k of ['intro', 'outro']) {
  route('GET', `/api/music/${k}`, async () => ({ status: 200, body: { [k]: Music.getBumper(k) } }));
  route('POST', `/api/music/${k}`, async (req, params, query) => {
    const orig = query.get('name') || '';
    const { file, full } = Music.bumperTarget(k, orig);
    await saveUpload(req, full, MAX_CLIP);
    return { status: 200, body: { [k]: await Music.registerBumper(k, file, orig, cfg.getSettings()) } };
  });
  route('DELETE', `/api/music/${k}`, async () => {
    Music.removeBumper(k);
    return { status: 200, body: { [k]: null } };
  });
}
// logo kênh dùng chung: góc video, sau intro (tuỳ chọn)
route('GET', '/api/music/logo', async () => ({ status: 200, body: { logo: Music.getLogo() } }));
route('POST', '/api/music/logo', async (req, params, query) => {
  const orig = query.get('name') || '';
  const { file, full } = Music.logoTarget(orig);
  await saveUpload(req, full);
  return { status: 200, body: { logo: await Music.registerLogo(file, orig, cfg.getSettings()) } };
});
route('PUT', '/api/music/logo', async (req) => ({ status: 200, body: { logo: await Music.updateLogo(await readJson(req), cfg.getSettings()) } }));
route('DELETE', '/api/music/logo', async () => {
  Music.removeLogo();
  return { status: 200, body: { logo: null } };
});
route('GET', '/api/music', async () => ({ status: 200, body: Music.list() }));
route('POST', '/api/music', async (req) => ({ status: 200, body: Music.publicProject(Music.create((await readJson(req)).name)) }));
route('GET', '/api/music/:id', async (req, { id }) => ({ status: 200, body: Music.publicProject(Music.load(id)) }));
route('PUT', '/api/music/:id', async (req, { id }) => {
  const p = Music.load(id);
  if (p.status === 'queued' || p.status === 'running') throw pipeline.httpError(409, 'Dự án đang dựng, chờ xong rồi sửa.');
  Music.applyData(p, await readJson(req, 4 * 1024 * 1024));
  return { status: 200, body: Music.publicProject(p) };
});
route('DELETE', '/api/music/:id', async (req, { id }) => {
  Music.remove(id);
  return { status: 200, body: { ok: true } };
});
route('POST', '/api/music/:id/assets', async (req, { id }, query) => {
  const kind = query.get('kind') === 'song' ? 'song' : 'clip';
  const orig = query.get('name') || '';
  const { file, full } = Music.assetTarget(id, kind, orig);
  await saveUpload(req, full, kind === 'clip' ? MAX_CLIP : MAX_ASSET);
  const p = await Music.registerAsset(id, kind, file, orig, cfg.getSettings());
  return { status: 200, body: { file, name: orig, project: Music.publicProject(p) } };
});
route('DELETE', '/api/music/:id/clips/:file', async (req, { id, file }) => ({ status: 200, body: Music.publicProject(Music.removeClip(id, decodeURIComponent(file))) }));
route('POST', '/api/music/:id/clips/delete', async (req, { id }) => {
  const b = await readJson(req);
  return { status: 200, body: Music.publicProject(Music.removeClips(id, b.files)) };
});
// AI xem một clip (3 khung hình) -> mô tả, từ khoá, mức sôi động
route('POST', '/api/music/:id/ai/describe', async (req, { id }, query, res) => {
  const signal = abortOnClose(res);
  const b = await readJson(req);
  return { status: 200, body: await Music.describeClip(id, String(b.file || ''), cfg.getSettings(), { force: !!b.force, signal }) };
});
// AI xếp clip cho từng câu hát theo lời + nhịp + độ sôi động
route('POST', '/api/music/:id/ai/arrange', async (req, { id }, query, res) => {
  const signal = abortOnClose(res);
  const p = Music.load(id);
  if (p.status === 'queued' || p.status === 'running') throw pipeline.httpError(409, 'Dự án đang dựng, chờ xong rồi xếp lại.');
  const b = await readJson(req, 4 * 1024 * 1024);
  if (b.data) Music.applyData(p, b.data);
  return { status: 200, body: Music.publicProject(await Music.aiArrange(id, cfg.getSettings(), signal)) };
});
// AI nghe bài hát -> tự chép lời + thời gian từng câu (cần Gemini)
route('POST', '/api/music/:id/ai/transcribe', async (req, { id }, query, res) => {
  const signal = abortOnClose(res);
  const p = Music.load(id);
  if (p.status === 'queued' || p.status === 'running') throw pipeline.httpError(409, 'Dự án đang dựng, chờ xong rồi làm lại.');
  const b = await readJson(req, 4 * 1024 * 1024);
  if (b.data) Music.applyData(p, b.data);
  return { status: 200, body: Music.publicProject(await Music.aiTranscribe(id, cfg.getSettings(), signal)) };
});
// AI nghe bài hát -> chấm thời gian từng câu (cần Gemini)
route('POST', '/api/music/:id/ai/align', async (req, { id }, query, res) => {
  const signal = abortOnClose(res);
  const p = Music.load(id);
  if (p.status === 'queued' || p.status === 'running') throw pipeline.httpError(409, 'Dự án đang dựng, chờ xong rồi chấm lại.');
  const b = await readJson(req, 4 * 1024 * 1024);
  if (b.data) Music.applyData(p, b.data);
  return { status: 200, body: Music.publicProject(await Music.aiAlign(id, cfg.getSettings(), signal)) };
});
// AI nghe bài hát -> mốc bắt đầu từng đoạn (Intro, Verse 1, Chorus 1…) theo lời có nhãn đoạn (cần Gemini)
route('POST', '/api/music/:id/ai/sections', async (req, { id }, query, res) => {
  const signal = abortOnClose(res);
  const p = Music.load(id);
  if (p.status === 'queued' || p.status === 'running') throw pipeline.httpError(409, 'Dự án đang dựng, chờ xong rồi làm lại.');
  const b = await readJson(req, 4 * 1024 * 1024);
  if (b.data) Music.applyData(p, b.data);
  return { status: 200, body: Music.publicProject(await Music.aiSections(id, cfg.getSettings(), signal)) };
});
route('POST', '/api/music/:id/run', async (req, { id }) => ({ status: 200, body: Music.publicProject(Music.start(id, (await readJson(req, 4 * 1024 * 1024)).data)) }));
route('POST', '/api/music/:id/cancel', async (req, { id }) => ({ status: 200, body: Music.publicProject(Music.cancel(id)) }));
route('POST', '/api/music/:id/reveal', async (req, { id }) => {
  const p = Music.load(id);
  const dir = Music.mdir(p.id);
  const out = path.join(dir, Music.videoFile(p));
  const file = p.files.video && fs.existsSync(out) ? out : null;
  const [cmd, args] = process.platform === 'darwin' ? ['open', file ? ['-R', file] : [dir]] : process.platform === 'win32' ? ['explorer', [file ? '/select,' + file : dir]] : ['xdg-open', [dir]];
  await new Promise((resolve, reject) => execFile(cmd, args, (err) => (err && process.platform !== 'win32' ? reject(pipeline.httpError(500, 'Không mở được thư mục: ' + err.message)) : resolve())));
  return { status: 200, body: { ok: true, dir } };
});

const MFILE_RE = /^(clips\/(clip|img)_[\w.\-]+|thumbs\/thumb_[\w.\-]+\.jpg|song_[\w.\-]+|output\.mp4|lyrics\.srt|lyrics\.lrc)$/;

const FILE_RE = /^(images\/img_[\w.\-]+|voice\.mp3|voice\.srt|output\.mp4|bgm_[\w.\-]+)$/;

async function handle(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  guard(req);
  const p = decodeURIComponent(u.pathname);

  if (p.startsWith('/files/')) {
    const m = /^\/files\/([a-f0-9]{12})\/(.+)$/.exec(p);
    if (!m || !FILE_RE.test(m[2])) return sendJson(res, 404, { error: 'Không tìm thấy' });
    const dl = u.searchParams.get('download');
    const proj = pipeline.load(m[1]);
    const nice = (proj.title || proj.script.slice(0, 40) || 'video').replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 60);
    const ext = path.extname(m[2]);
    return serveFile(req, res, path.join(pipeline.pdir(m[1]), m[2]), { download: !!dl, name: ext === '.mp4' || ext === '.mp3' || ext === '.srt' ? `${nice}${ext}` : undefined });
  }

  if (p.startsWith('/mfiles/')) {
    const m = /^\/mfiles\/([a-z0-9-]+)\/(.+)$/.exec(p);
    if (!m || !Music.isId(m[1])) return sendJson(res, 404, { error: 'Không tìm thấy' });
    const proj = Music.load(m[1]);
    // video xuất ra mang tên video người dùng nhập (dự án cũ: output.mp4)
    if (!MFILE_RE.test(m[2]) && m[2] !== Music.videoFile(proj)) return sendJson(res, 404, { error: 'Không tìm thấy' });
    const nice = (proj.title || 'video-nhac').replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 60) || 'video-nhac';
    const ext = path.extname(m[2]);
    return serveFile(req, res, path.join(Music.mdir(m[1]), m[2]), { download: !!u.searchParams.get('download'), name: ['.mp4', '.srt', '.lrc'].includes(ext) ? `${nice}${ext}` : undefined });
  }

  if (p.startsWith('/mlogo/')) {
    const f = p.slice('/mlogo/'.length);
    if (!Music.LOGO_RE.test(f)) return sendJson(res, 404, { error: 'Không tìm thấy' });
    return serveFile(req, res, path.join(Music.LOGO_DIR, f));
  }
  if (p.startsWith('/mintro/')) {
    const f = p.slice('/mintro/'.length);
    if (!Music.INTRO_RE.test(f)) return sendJson(res, 404, { error: 'Không tìm thấy' });
    return serveFile(req, res, path.join(Music.INTRO_DIR, f));
  }
  if (p.startsWith('/moutro/')) {
    const f = p.slice('/moutro/'.length);
    if (!Music.OUTRO_RE.test(f)) return sendJson(res, 404, { error: 'Không tìm thấy' });
    return serveFile(req, res, path.join(Music.OUTRO_DIR, f));
  }

  if (p.startsWith('/api/')) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(p);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = m[i + 1]));
      const out = await r.handler(req, params, u.searchParams, res);
      return sendJson(res, out.status, out.body);
    }
    return sendJson(res, 404, { error: 'API không tồn tại' });
  }

  // file tĩnh của giao diện
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
  const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const full = path.join(PUBLIC, rel);
  if (!full.startsWith(PUBLIC + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  return serveFile(req, res, full);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (res.headersSent) return res.end();
    sendJson(res, e.status || 500, { error: e.message || 'Lỗi máy chủ' });
    if (!e.status) console.error(e);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  GenVideo AI đang chạy: http://localhost:${PORT}\n  Dữ liệu lưu tại: ${cfg.DATA}\n`);
  FF.check(cfg.getSettings()).then((c) => {
    if (!c.ok) console.log('  ⚠ FFmpeg chưa sẵn sàng: ' + (c.error || 'thiếu bộ lọc zoompan') + '\n    Cài bằng: brew install ffmpeg\n');
    else if (!c.libass) console.log('  ⚠ FFmpeg này không có libass nên không đốt được phụ đề. Cài bản đầy đủ: brew install ffmpeg\n');
    else console.log('  FFmpeg OK: ' + c.version + '\n');
  });
});
