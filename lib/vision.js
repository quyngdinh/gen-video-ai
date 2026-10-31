'use strict';
// AI nhìn ảnh để gợi ý hiệu ứng phủ (Claude hoặc Gemini). Gọi HTTP trực tiếp vì dự án không dùng thư viện npm.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const FF = require('./ffmpeg');
const FX = require('./effects');

const ANTHROPIC_BASE = (process.env.GVA_ANTHROPIC_BASE || 'https://api.anthropic.com').replace(/\/+$/, '');
const GEMINI_BASE = (process.env.GVA_GEMINI_BASE || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
const ANTHROPIC_VERSION = '2026-10-21';
// model có tham số fallbacks "default": nếu bị bộ lọc an toàn từ chối, API tự chạy lại bằng model phù hợp
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const PROVIDERS = ['anthropic', 'gemini'];
const PROVIDER_NAME = { anthropic: 'Claude', gemini: 'Gemini' };
const KEY_FIELD = { anthropic: 'anthropicKey', gemini: 'geminiKey' };
const MODEL_FIELD = { anthropic: 'aiModelAnthropic', gemini: 'aiModelGemini' };
const CACHE_FILE = path.join(cfg.DATA, 'ai-cache.json');

const httpErr = (status, message) => Object.assign(new Error(message), { status });

function keyOf(settings, provider) {
  const key = settings[KEY_FIELD[provider]];
  if (!key) throw httpErr(400, `Chưa có API key ${PROVIDER_NAME[provider]} — vào Cài đặt để nhập.`);
  return key;
}

const STOPPED = 'Đã dừng';

async function call(url, { method = 'GET', headers = {}, body, label, timeoutMs = 120000, signal }) {
  let res;
  try {
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    res = await fetch(url, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: sig });
  } catch (e) {
    if (signal?.aborted) throw httpErr(499, STOPPED);
    throw httpErr(502, `${label}: không kết nối được (${e.name === 'TimeoutError' ? 'quá thời gian chờ' : e.message})`);
  }
  const text = await res.text();
  let j = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch (_) {}
  if (!res.ok) {
    const msg = j?.error?.message || j?.message || text.slice(0, 300) || res.statusText;
    throw Object.assign(httpErr(res.status === 401 || res.status === 403 ? 400 : 502, `${label} ${res.status}: ${msg}`), { httpStatus: res.status });
  }
  return j;
}

const anthropicHeaders = (key, extra = {}) => ({ 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, ...extra });

// khả năng của từng model Claude (lấy từ /v1/models) để chỉ gửi tham số model đó hỗ trợ
const claudeCaps = new Map();

/** Danh sách model nhìn được ảnh của nhà cung cấp: [{ id, name }]. */
async function listModels(settings, provider) {
  if (!PROVIDERS.includes(provider)) throw httpErr(400, 'Nhà cung cấp AI không hợp lệ');
  const key = keyOf(settings, provider);
  if (provider === 'anthropic') {
    const out = [];
    let after = '';
    for (let i = 0; i < 5; i++) {
      const j = await call(`${ANTHROPIC_BASE}/v1/models?limit=1000${after ? '&after_id=' + encodeURIComponent(after) : ''}`, { headers: anthropicHeaders(key), label: 'Claude' });
      for (const m of j?.data || []) {
        if (m.capabilities) claudeCaps.set(m.id, m.capabilities);
        if (m.capabilities?.image_input?.supported === false) continue;
        out.push({ id: m.id, name: m.display_name || m.id });
      }
      if (!j?.has_more || !j.last_id) break;
      after = j.last_id;
    }
    return out;
  }
  const out = [];
  let token = '';
  for (let i = 0; i < 5; i++) {
    const j = await call(`${GEMINI_BASE}/v1beta/models?pageSize=1000${token ? '&pageToken=' + encodeURIComponent(token) : ''}`, { headers: { 'x-goog-api-key': key }, label: 'Gemini' });
    for (const m of j?.models || []) {
      const id = String(m.name || '').replace(/^models\//, '');
      if (!/^gemini/i.test(id) || !(m.supportedGenerationMethods || []).includes('generateContent')) continue;
      if (/embedding|tts|image-generation|native-audio|live|robotics|computer-use/i.test(id)) continue;
      out.push({ id, name: m.displayName || id });
    }
    token = j?.nextPageToken;
    if (!token) break;
  }
  return out;
}

const PROMPT = `Bạn chọn hiệu ứng động phủ lên một ảnh minh hoạ tĩnh trong video kể chuyện (ảnh đứng yên, chỉ có hiệu ứng phủ chuyển động).
Các hiệu ứng có thể dùng:
${FX.IDS.map((id) => `- ${id}: ${FX.EFFECTS[id].label} — ${FX.EFFECTS[id].hint}`).join('\n')}

Quy tắc:
- Chỉ chọn hiệu ứng khớp với thứ thật sự nhìn thấy trong ảnh: lửa trại / đuốc / đèn dầu -> fire; trời đang mưa -> rain; tuyết rơi hoặc cảnh tuyết -> snow; sương mù, khói mờ, hơi nước -> fog; cảnh đêm, hang tối, nắng chiếu có bụi -> dust; sét / giông -> lightning.
- grain chỉ dùng cho cảnh hồi tưởng / hoài niệm.
- Tối đa 3 hiệu ứng. Ảnh giải thích, sơ đồ, đồ hoạ thông tin thì để trống hoặc chỉ 1 hiệu ứng nhẹ.
- fire: toạ độ chân ngọn lửa của từng nguồn lửa thấy rõ (tối đa 3, nguồn lớn nhất trước). x, y là tỉ lệ 0..1 theo chiều rộng / chiều cao ảnh, gốc (0,0) ở góc trên bên trái. Không chọn fire thì fire = [].
- reason: một câu tiếng Việt ngắn giải thích lựa chọn.
- desc: mô tả ngắn nội dung ảnh bằng tiếng Việt (ai / con vật gì, đang làm gì, ở đâu, đồ vật nổi bật), tối đa 30 từ — dùng để ghép ảnh với kịch bản.
Chỉ trả về JSON dạng {"effects": [...], "fire": [{"x": 0.5, "y": 0.8}], "reason": "...", "desc": "..."}.`;

const SCHEMA = {
  type: 'object',
  properties: {
    effects: { type: 'array', items: { type: 'string', enum: FX.IDS } },
    fire: {
      type: 'array',
      items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false },
    },
    reason: { type: 'string' },
    desc: { type: 'string' },
  },
  required: ['effects', 'fire', 'reason', 'desc'],
  additionalProperties: false,
};

function parseJson(text, label) {
  const m = /\{[\s\S]*\}/.exec(text || '');
  try {
    return JSON.parse(m ? m[0] : text);
  } catch (_) {
    throw httpErr(502, `${label} trả về không đúng định dạng: ${String(text || '').slice(0, 200)}`);
  }
}

/**
 * Gọi model của từng nhà cung cấp với một prompt (kèm ảnh JPEG base64 nếu có), trả về JSON đã parse.
 * q: { prompt, schema, b64?, effort?, maxTokens? }
 */
async function askClaude(key, model, q, signal) {
  const caps = claudeCaps.get(model);
  const content = [];
  if (q.b64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: q.b64 } });
  content.push({ type: 'text', text: q.prompt });
  const body = { model, max_tokens: q.maxTokens || 16000, messages: [{ role: 'user', content }] };
  const oc = {};
  if (q.effort && caps?.effort?.supported && caps.effort[q.effort]?.supported !== false) oc.effort = q.effort;
  if (!caps || caps.structured_outputs?.supported) oc.format = { type: 'json_schema', schema: q.schema };
  if (Object.keys(oc).length) body.output_config = oc;
  const extra = {};
  if (FALLBACK_MODELS.has(model)) {
    extra['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }
  const j = await call(`${ANTHROPIC_BASE}/v1/messages`, { method: 'POST', headers: anthropicHeaders(key, extra), body, label: 'Claude', signal, timeoutMs: q.timeoutMs });
  if (j?.stop_reason === 'refusal') throw httpErr(502, 'Claude từ chối yêu cầu này' + (j.stop_details?.explanation ? ': ' + j.stop_details.explanation : '.'));
  if (j?.stop_reason === 'max_tokens') throw httpErr(502, 'Claude trả lời bị cắt giữa chừng (hết max_tokens).');
  const text = (j?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { data: parseJson(text, 'Claude'), model: j?.model || model };
}

async function askGemini(key, model, q, signal) {
  const parts = [];
  if (q.b64) parts.push({ inline_data: { mime_type: 'image/jpeg', data: q.b64 } });
  parts.push({ text: q.prompt });
  const body = { contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json' } };
  const j = await call(`${GEMINI_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': key }, body, label: 'Gemini', signal, timeoutMs: q.timeoutMs });
  if (j?.promptFeedback?.blockReason) throw httpErr(502, 'Gemini chặn yêu cầu này: ' + j.promptFeedback.blockReason);
  const text = (j?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  return { data: parseJson(text, 'Gemini'), model };
}

/** Chọn nhà cung cấp + model + key đang cài, rồi hỏi. */
async function ask(settings, q, signal) {
  const provider = PROVIDERS.includes(settings.aiProvider) ? settings.aiProvider : 'anthropic';
  const model = settings[MODEL_FIELD[provider]];
  if (!model) throw httpErr(400, 'Chưa chọn model AI — vào Cài đặt để chọn.');
  const key = keyOf(settings, provider);
  if (provider === 'anthropic' && !claudeCaps.has(model)) await listModels(settings, 'anthropic').catch(() => {});
  const r =
    provider === 'gemini' ? await askGemini(key, model, q, signal) : await askClaude(key, model, q, signal);
  return { ...r, provider };
}

/** Thu nhỏ ảnh (cạnh dài ≤ 1280px, JPEG) trước khi gửi để tiết kiệm token. */
async function shrink(settings, buf, signal) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gva-ai-'));
  const src = path.join(tmp, 'in');
  const out = path.join(tmp, 'out.jpg');
  try {
    fs.writeFileSync(src, buf);
    await FF.run(settings.ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-frames:v', '1', '-vf', "scale='if(gte(iw,ih),min(1280,iw),-2)':'if(gte(iw,ih),-2,min(1280,ih))'", '-q:v', '4', out], { signal });
    return fs.readFileSync(out);
  } catch (e) {
    if (signal?.aborted) throw httpErr(499, STOPPED);
    throw httpErr(400, 'Không đọc được ảnh: ' + e.message.slice(0, 200));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

/** Gợi ý hiệu ứng cho một ảnh. Kết quả được nhớ theo nội dung ảnh + model -> không tốn tiền lần hai. */
/** signal: huỷ khi người dùng bấm Dừng (trình duyệt ngắt kết nối) -> không gọi / không tính tiền thêm. */
async function suggest(settings, buf, { force = false, signal } = {}) {
  const provider = PROVIDERS.includes(settings.aiProvider) ? settings.aiProvider : 'anthropic';
  const model = settings[MODEL_FIELD[provider]];
  if (!model) throw httpErr(400, 'Chưa chọn model AI — vào Cài đặt để chọn.');
  keyOf(settings, provider);
  // v2: kết quả có thêm mô tả ảnh (desc) để ghép ảnh với kịch bản
  const ck = `v2:${provider}:${model}:${crypto.createHash('sha1').update(buf).digest('hex')}`;
  const cache = readCache();
  if (!force && cache[ck]) return { ...cache[ck], cached: true };

  const b64 = (await shrink(settings, buf, signal)).toString('base64');
  if (signal?.aborted) throw httpErr(499, STOPPED);
  // việc phân loại đơn giản -> effort thấp cho nhanh và rẻ
  const r = await ask(settings, { prompt: PROMPT, schema: SCHEMA, b64, effort: 'low', maxTokens: 16000 }, signal);
  const fx = FX.normalizeFx({ ...r.data, ai: { provider, model: r.model, reason: r.data?.reason, desc: r.data?.desc } }) || { effects: [], fire: [] };
  if (!fx.effects.includes('fire')) fx.fire = [];

  const next = readCache();
  next[ck] = fx;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - 2000))) delete next[k];
  fs.writeFileSync(CACHE_FILE, JSON.stringify(next));
  return fx;
}

// ---------- ghép ảnh với kịch bản ----------
const STORY_SCHEMA = {
  type: 'object',
  properties: {
    assign: { type: 'array', items: { type: 'integer' } },
    unused: { type: 'array', items: { type: 'integer' } },
    weak: { type: 'array', items: { type: 'integer' } },
    notes: { type: 'string' },
  },
  required: ['assign', 'unused', 'weak', 'notes'],
  additionalProperties: false,
};

/**
 * blocks: [đoạn kịch bản], images: [{ name, desc }].
 * Trả về { assign: [chỉ số ảnh 0-based | -1 cho từng đoạn], unused, weak, notes, model }.
 */
async function storyboard(settings, { blocks, images }, signal) {
  if (!blocks.length) throw httpErr(400, 'Chưa có kịch bản.');
  if (!images.length) throw httpErr(400, 'Chưa có ảnh nào.');
  const prompt = `Bạn dựng video kể chuyện từ giọng đọc + ảnh minh hoạ tĩnh. Kịch bản đã chia thành ${blocks.length} đoạn (đánh số), và có ${images.length} ảnh (đánh số, kèm tên file và mô tả nội dung).
Hãy chọn ảnh minh hoạ hợp nhất cho TỪNG đoạn.

Quy tắc:
- assign: mảng đúng ${blocks.length} số nguyên; phần tử thứ i là số thứ tự ảnh (1..${images.length}) cho đoạn i.
- Ưu tiên ảnh khớp nội dung đoạn: nhân vật, hành động, bối cảnh, đồ vật, cảm xúc. Tên file (tiếng Anh) và mô tả đều là gợi ý.
- Đi theo diễn biến câu chuyện; một ảnh có thể dùng cho vài đoạn liền nhau nếu cùng một cảnh, và dùng lại khi câu chuyện quay về cảnh đó. Hạn chế nhảy qua lại vô cớ.
- Dùng càng nhiều ảnh khớp càng tốt, nhưng KHÔNG dùng ảnh không liên quan chỉ để cho đủ.
- unused: số thứ tự các ảnh không khớp đoạn nào (không dùng).
- weak: số thứ tự các đoạn không có ảnh nào khớp tốt (khi đó chọn ảnh gần nghĩa nhất, thường là ảnh của đoạn trước).
- notes: 1–2 câu tiếng Việt tóm tắt cách xếp.
Chỉ trả về JSON {"assign": [...], "unused": [...], "weak": [...], "notes": "..."}.

ẢNH:
${images.map((im, i) => `${i + 1}. [${String(im.name || '').slice(0, 120)}] ${String(im.desc || '').slice(0, 300)}`).join('\n')}

KỊCH BẢN:
${blocks.map((b, i) => `${i + 1}. ${b}`).join('\n')}`;
  // việc ghép cần suy luận theo mạch truyện -> để effort mặc định; câu trả lời dài nên cho chờ lâu hơn
  const r = await ask(settings, { prompt, schema: STORY_SCHEMA, maxTokens: 16000, timeoutMs: 300000 }, signal);
  const n = images.length;
  const raw = Array.isArray(r.data?.assign) ? r.data.assign : [];
  const assign = blocks.map((_, i) => {
    const v = Number(raw[i]);
    return Number.isInteger(v) && v >= 1 && v <= n ? v - 1 : -1;
  });
  // đoạn thiếu ảnh -> dùng ảnh của đoạn trước (hoặc đoạn sau ở đầu)
  for (let i = 0; i < assign.length; i++) if (assign[i] < 0 && i > 0) assign[i] = assign[i - 1];
  for (let i = assign.length - 1; i >= 0; i--) if (assign[i] < 0 && i < assign.length - 1) assign[i] = assign[i + 1];
  const used = new Set(assign);
  const idx = (arr, max) => [...new Set((Array.isArray(arr) ? arr : []).map(Number).filter((v) => Number.isInteger(v) && v >= 1 && v <= max).map((v) => v - 1))];
  return {
    assign,
    unused: [...Array(n).keys()].filter((i) => !used.has(i)),
    weak: idx(r.data?.weak, blocks.length),
    notes: String(r.data?.notes || '').slice(0, 500),
    model: r.model,
    provider: r.provider,
    fixed: raw.length !== blocks.length,
  };
}

module.exports = { PROVIDERS, PROVIDER_NAME, KEY_FIELD, listModels, suggest, storyboard, ask };
