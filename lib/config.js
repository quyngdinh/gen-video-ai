'use strict';
// Cấu hình + lưu Settings (API key nằm trên máy bạn, không bao giờ gửi về trình duyệt).
// API key lưu trong file .env (đã gitignore), các tuỳ chọn khác lưu ở data/settings.json.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.GVA_DATA ? path.resolve(process.env.GVA_DATA) : path.join(ROOT, 'data');
const PROJECTS = path.join(DATA, 'projects');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const FAV_FILE = path.join(DATA, 'favorite-voices.json');
// Khi chạy với GVA_DATA (test) thì .env nằm trong thư mục data đó để không đụng key thật.
const ENV_FILE = process.env.GVA_ENV_FILE
  ? path.resolve(process.env.GVA_ENV_FILE)
  : process.env.GVA_DATA
    ? path.join(DATA, '.env')
    : path.join(ROOT, '.env');

fs.mkdirSync(PROJECTS, { recursive: true });

const DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://api.genmax.io',
  provider: 'elevenlabs', // elevenlabs | minimax | capcut
  modelId: 'eleven_multilingual_v2',
  voiceId: '',
  voiceName: '',
  languageCode: 'vi',
  speed: 1,
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  exportTranscript: true,
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  subtitleFont: 'Arial',
  // AI nhìn ảnh để gợi ý hiệu ứng
  aiProvider: 'anthropic', // anthropic | gemini
  anthropicKey: '',
  geminiKey: '',
  aiModelAnthropic: 'claude-opus-5-5',
  aiModelGemini: '',
};
const SECRETS = ['apiKey', 'anthropicKey', 'geminiKey'];
// tên biến trong .env cho từng key
const ENV_NAMES = {
  apiKey: 'GVA_GENMAX_API_KEY',
  anthropicKey: 'GVA_ANTHROPIC_API_KEY',
  geminiKey: 'GVA_GEMINI_API_KEY',
};

// ---------- .env ----------
function readEnvFile() {
  const out = {};
  let txt = '';
  try {
    txt = fs.readFileSync(ENV_FILE, 'utf8');
  } catch (_) {
    return out;
  }
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

/** Ghi/cập nhật các biến vào .env, giữ nguyên các dòng khác. */
function writeEnvVars(vars) {
  let lines = [];
  try {
    lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  } catch (_) {
    lines = ['# API key của gen-video-ai — KHÔNG commit file này lên git'];
  }
  const left = { ...vars };
  lines = lines.map((line) => {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!m || !(m[1] in left)) return line;
    const v = left[m[1]];
    delete left[m[1]];
    return `${m[1]}=${v}`;
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [k, v] of Object.entries(left)) lines.push(`${k}=${v}`);
  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(ENV_FILE, 0o600);
  } catch (_) {}
}

function getSecrets() {
  const env = readEnvFile();
  const out = {};
  for (const k of SECRETS) {
    const n = ENV_NAMES[k];
    out[k] = String((n in env ? env[n] : process.env[n]) || '').trim();
  }
  return out;
}

function readSettingsFile() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (_) {
    return {}; /* chưa có file */
  }
}

function writeSettingsFile(obj) {
  const clean = { ...obj };
  for (const k of SECRETS) delete clean[k];
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(clean, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(SETTINGS_FILE, 0o600);
  } catch (_) {}
}

// Bản cũ lưu key trong settings.json -> chuyển sang .env rồi xoá khỏi settings.json.
(function migrateSecrets() {
  const saved = readSettingsFile();
  if (!SECRETS.some((k) => k in saved)) return;
  const env = readEnvFile();
  const move = {};
  for (const k of SECRETS) {
    const v = typeof saved[k] === 'string' ? saved[k].trim() : '';
    if (v && !env[ENV_NAMES[k]]) move[ENV_NAMES[k]] = v;
  }
  if (Object.keys(move).length) writeEnvVars(move);
  writeSettingsFile(saved);
})();

function getSettings() {
  const saved = readSettingsFile();
  for (const k of SECRETS) delete saved[k];
  return { ...DEFAULTS, ...saved, ...getSecrets() };
}

function saveSettings(patch) {
  const cur = getSettings();
  const next = { ...cur };
  for (const k of Object.keys(DEFAULTS)) {
    if (patch[k] === undefined) continue;
    if (SECRETS.includes(k)) {
      // chuỗi rỗng = giữ key cũ; muốn xoá thì gửi clear<Tên key>
      if (typeof patch[k] === 'string' && patch[k].trim()) next[k] = patch[k].trim();
      continue;
    }
    next[k] = patch[k];
  }
  for (const k of SECRETS) if (patch['clear' + k[0].toUpperCase() + k.slice(1)]) next[k] = '';
  if (!['anthropic', 'gemini'].includes(next.aiProvider)) next.aiProvider = 'anthropic';
  next.baseUrl = String(next.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '');
  for (const k of ['speed', 'stability', 'similarityBoost', 'style']) next[k] = Number(next[k]);
  const envPatch = {};
  for (const k of SECRETS) if (next[k] !== cur[k]) envPatch[ENV_NAMES[k]] = next[k];
  if (Object.keys(envPatch).length) writeEnvVars(envPatch);
  writeSettingsFile(next);
  return next;
}

function publicSettings() {
  const s = getSettings();
  const out = { ...s };
  for (const k of SECRETS) {
    out[k + 'Set'] = !!s[k];
    out[k + 'Hint'] = s[k] ? '••••' + s[k].slice(-4) : '';
    delete out[k];
  }
  return out;
}

// ---------- giọng yêu thích ----------
const PROVIDERS = ['elevenlabs', 'minimax', 'capcut'];

function getFavorites() {
  try {
    const j = JSON.parse(fs.readFileSync(FAV_FILE, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch (_) {
    return [];
  }
}

/** Bật/tắt yêu thích; chỉ lưu các trường hiển thị cần thiết. */
function setFavorite(v, on) {
  if (!v || !PROVIDERS.includes(v.provider) || !v.voiceId) throw Object.assign(new Error('Giọng không hợp lệ'), { status: 400 });
  const str = (x, n) => String(x ?? '').slice(0, n);
  const item = {
    provider: v.provider,
    voiceId: str(v.voiceId, 120),
    name: str(v.name, 160),
    description: str(v.description, 400),
    tags: (Array.isArray(v.tags) ? v.tags : []).slice(0, 6).map((t) => str(t, 40)),
    previewUrl: /^https?:\/\//.test(v.previewUrl || '') ? str(v.previewUrl, 600) : '',
    image: /^https?:\/\//.test(v.image || '') ? str(v.image, 600) : '',
    langs: (Array.isArray(v.langs) ? v.langs : []).slice(0, 12).map((t) => str(t, 40)),
  };
  const list = getFavorites().filter((f) => !(f.provider === item.provider && f.voiceId === item.voiceId));
  if (on) list.unshift(item);
  fs.writeFileSync(FAV_FILE, JSON.stringify(list.slice(0, 300), null, 2));
  return list;
}

module.exports = { ROOT, DATA, PROJECTS, DEFAULTS, PROVIDERS, getSettings, saveSettings, publicSettings, getFavorites, setFavorite };
