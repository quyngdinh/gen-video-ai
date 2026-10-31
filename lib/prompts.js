'use strict';
// Viết prompt tạo ảnh cho từng cảnh của kịch bản (để người dùng tự tạo ảnh bằng Gemini / ChatGPT / Midjourney…).
// Bước 1: đọc cả kịch bản -> bộ phong cách chung + mô tả cố định từng nhân vật (giữ ảnh đồng nhất).
// Bước 2: viết prompt theo từng lô cảnh, dùng lại phong cách + nhân vật ở bước 1.
const Vision = require('./vision');
const S = require('./srt');

const TOOLS = {
  gemini: 'Gemini (Nano Banana / Imagen): viết câu mô tả tự nhiên, rõ ràng',
  chatgpt: 'ChatGPT (GPT image): viết câu mô tả tự nhiên, rõ ràng',
  midjourney: 'Midjourney: cụm mô tả ngắn gọn, cách nhau bằng dấu phẩy',
  generic: 'công cụ tạo ảnh bất kỳ: câu mô tả tự nhiên',
};
const BATCH = 20;

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const slug = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-') || 'scene';

/** Các cảnh của kịch bản (cùng cách chia với "Xếp ảnh theo kịch bản"). */
function scenesOf(script) {
  return S.storyBlocks(String(script || '').slice(0, 300000)).map((b) => b.text);
}

const MAX_STYLES = 3;
const STYLE_SCHEMA = {
  type: 'object',
  properties: {
    styles: {
      type: 'array',
      items: { type: 'object', properties: { n: { type: 'integer' }, desc: { type: 'string' }, use: { type: 'string' } }, required: ['n', 'desc', 'use'], additionalProperties: false },
    },
    characters: {
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string' }, look: { type: 'string' } }, required: ['name', 'look'], additionalProperties: false },
    },
  },
  required: ['styles', 'characters'],
  additionalProperties: false,
};

/** Phong cách người dùng nhập: [{ text, when }] (tối đa 3), chấp nhận cả chuỗi cũ. */
function userStylesOf(v) {
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .map((x) => (typeof x === 'string' ? { text: x } : x || {}))
    .map((x) => ({ text: clean(x.text, 400), when: clean(x.when, 200) }))
    .filter((x) => x.text)
    .slice(0, MAX_STYLES);
}

/** Bộ phong cách của guide, chấp nhận dữ liệu cũ chỉ có một chuỗi `style`. */
function guideStyles(guide) {
  if (Array.isArray(guide?.styles) && guide.styles.length) return guide.styles.slice(0, MAX_STYLES).map((x) => ({ desc: clean(x?.desc, 900), use: clean(x?.use, 300) }));
  return guide?.style ? [{ desc: clean(guide.style, 900), use: '' }] : [];
}

/** Bước 1: phong cách (1–3 bộ) + nhân vật. userStyles: phong cách người dùng muốn (bắt buộc ít nhất 1). */
async function styleGuide(settings, { script, userStyles, aspect }, signal) {
  const scenes = scenesOf(script);
  if (!scenes.length) throw httpErr(400, 'Chưa có kịch bản.');
  const us = userStylesOf(userStyles);
  if (!us.length) throw httpErr(400, 'Hãy nhập phong cách ảnh trước khi tạo prompt.');
  const multi = us.length > 1;
  const list = us.map((x, i) => `${i + 1}. "${x.text}"${x.when ? ` — người dùng muốn dùng cho: ${x.when}` : ''}`).join('\n');
  const prompt = `[task: visual-bible]
Bạn là đạo diễn hình ảnh cho một video kể chuyện ${aspect === '9:16' ? 'dọc 9:16' : 'ngang 16:9'} dùng ảnh minh hoạ tĩnh (mỗi cảnh ~15 giây một ảnh).
Người dùng yêu cầu ${multi ? `${us.length} phong cách hình ảnh` : 'phong cách hình ảnh'}:
${list}
Đọc toàn bộ kịch bản (tiếng Việt) bên dưới rồi trả về:
- styles: đúng ${us.length} phần tử, theo đúng thứ tự trên (n = 1${multi ? `..${us.length}` : ''}). desc: một đoạn TIẾNG ANH (40–70 từ) mô tả phong cách đó: kiểu vẽ, nét, bảng màu, ánh sáng, không khí. BẮT BUỘC giữ đúng phong cách người dùng yêu cầu — chỉ diễn đạt lại chi tiết hơn bằng tiếng Anh, không đổi sang phong cách khác. Kết thúc bằng câu "No text, letters or watermarks in the image." use: tiếng Việt ngắn (≤ 25 từ) nói phong cách này dùng cho những cảnh nào của kịch bản${multi ? ' (theo ý người dùng nếu có, nếu không thì tự chọn dựa trên nội dung kịch bản: ví dụ hiện tại / hồi tưởng / giải thích khoa học…)' : ' (thường là "mọi cảnh")'}.
- characters: các nhân vật xuất hiện nhiều lần (tối đa 8). name: tên như trong kịch bản; look: mô tả ngoại hình CỐ ĐỊNH bằng tiếng Anh (20–40 từ: dáng người, tóc, trang phục, màu sắc, đạo cụ đặc trưng) để mọi ảnh vẽ giống nhau${multi ? ' (mô tả ngoại hình, không mô tả kiểu vẽ — dùng chung cho mọi phong cách)' : ''}. Người kể / "bạn" cũng là nhân vật nếu xuất hiện trong cảnh.
Chỉ trả về JSON {"styles": [{"n": 1, "desc": "...", "use": "..."}], "characters": [{"name": "...", "look": "..."}]}.

KỊCH BẢN:
${scenes.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
  const r = await Vision.ask(settings, { prompt, schema: STYLE_SCHEMA, maxTokens: 16000, timeoutMs: 300000 }, signal);
  const got = new Map((Array.isArray(r.data?.styles) ? r.data.styles : []).map((x, i) => [Number(x?.n) || i + 1, x]));
  const styles = us.map((u, i) => {
    const x = got.get(i + 1);
    return { label: u.text, desc: clean(x?.desc, 900) || u.text, use: clean(x?.use, 300) || u.when || (multi ? '' : 'mọi cảnh') };
  });
  return {
    count: scenes.length,
    styles,
    characters: (Array.isArray(r.data?.characters) ? r.data.characters : []).slice(0, 8).map((c) => ({ name: clean(c?.name, 60), look: clean(c?.look, 400) })).filter((c) => c.name && c.look),
    model: r.model,
  };
}

const SCENES_SCHEMA = {
  type: 'object',
  properties: {
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { n: { type: 'integer' }, style: { type: 'integer' }, title: { type: 'string' }, prompt: { type: 'string' }, file: { type: 'string' } },
        required: ['n', 'style', 'title', 'prompt', 'file'],
        additionalProperties: false,
      },
    },
  },
  required: ['scenes'],
  additionalProperties: false,
};

/**
 * Bước 2: prompt cho các cảnh from..to (đánh số từ 1).
 * Trả về [{ n, style (1..3), title, prompt (đã ghép phong cách của cảnh + đuôi theo công cụ), file }].
 */
async function scenePrompts(settings, { script, from, to, guide, tool, aspect }, signal) {
  const scenes = scenesOf(script);
  if (guide?.count && guide.count !== scenes.length) throw httpErr(409, 'Kịch bản đã thay đổi — hãy tạo lại từ đầu.');
  const a = Math.max(1, Number(from) || 1);
  const z = Math.min(scenes.length, Number(to) || a + BATCH - 1, a + BATCH - 1);
  if (a > z) throw httpErr(400, 'Khoảng cảnh không hợp lệ.');
  const t = TOOLS[tool] ? tool : 'generic';
  const chars = (guide?.characters || []).map((c) => `- ${c.name}: ${c.look}`).join('\n') || '(không có nhân vật cố định)';
  const styles = guideStyles(guide);
  const multi = styles.length > 1;
  const styleText = multi
    ? `Có ${styles.length} phong cách — chọn phong cách hợp nhất cho từng cảnh (KHÔNG cần lặp lại mô tả phong cách trong prompt, app sẽ tự ghép phong cách đã chọn vào cuối):\n${styles.map((x, i) => `${i + 1}. ${x.desc}${x.use ? ` — dùng cho: ${x.use}` : ''}`).join('\n')}\nCác cảnh liền nhau cùng mạch (cùng hồi tưởng, cùng phần giải thích…) nên giữ cùng phong cách, tránh nhảy qua lại.`
    : `Phong cách chung (KHÔNG cần lặp lại trong prompt, app sẽ tự ghép vào cuối): ${styles[0]?.desc || '(tự chọn, nhất quán)'}`;
  const prompt = `[task: scene-prompts]
Viết prompt tạo ảnh cho các cảnh ${a}–${z} của một video kể chuyện (ảnh tĩnh, khung ${aspect === '9:16' ? 'dọc 9:16' : 'ngang 16:9'}). Công cụ tạo ảnh: ${TOOLS[t]}.

${styleText}
Nhân vật cố định — khi nhân vật xuất hiện, mô tả ngắn đúng ngoại hình này để các ảnh giống nhau:
${chars}

Yêu cầu cho mỗi cảnh:
- n: số cảnh.
- style: ${multi ? `số phong cách dùng cho cảnh này (1–${styles.length})` : 'luôn là 1'}.
- title: tiêu đề tiếng Việt ngắn (≤ 8 từ).
- prompt: TIẾNG ANH, 40–90 từ, minh hoạ đúng khoảnh khắc chính của đoạn kịch bản: ai, đang làm gì, ở đâu, đồ vật quan trọng, bố cục / góc máy, ánh sáng, cảm xúc. Cụ thể, nhìn thấy được; không viết lời thoại hay chữ trong ảnh. Giữ liền mạch với cảnh trước / sau (cùng bối cảnh thì mô tả bối cảnh giống nhau).
- file: 2–6 từ tiếng Anh viết thường nối bằng dấu gạch, mô tả cảnh (ví dụ "caveman-rubbing-sticks").
Chỉ trả về JSON {"scenes": [{"n": ${a}, "style": 1, "title": "...", "prompt": "...", "file": "..."}, ...]} với đủ ${z - a + 1} cảnh.

${a > 1 ? `(Đoạn ngay trước, để nối mạch) ${a - 1}. ${scenes[a - 2]}\n\n` : ''}CÁC CẢNH CẦN VIẾT:
${scenes
  .slice(a - 1, z)
  .map((s, i) => `${a + i}. ${s}`)
  .join('\n')}${z < scenes.length ? `\n\n(Đoạn ngay sau, để nối mạch) ${z + 1}. ${scenes[z]}` : ''}`;
  const r = await Vision.ask(settings, { prompt, schema: SCENES_SCHEMA, maxTokens: 16000, timeoutMs: 300000 }, signal);
  const got = new Map((Array.isArray(r.data?.scenes) ? r.data.scenes : []).map((s) => [Number(s?.n), s]));
  const pad = String(scenes.length).length < 2 ? 2 : String(scenes.length).length;
  const tail = t === 'midjourney' ? ` --ar ${aspect === '9:16' ? '9:16' : '16:9'}` : ` ${aspect === '9:16' ? 'Vertical 9:16' : 'Horizontal 16:9'} composition.`;
  const out = [];
  for (let n = a; n <= z; n++) {
    const s = got.get(n);
    const body = clean(s?.prompt, 1200);
    const k = multi && Number(s?.style) >= 1 && Number(s?.style) <= styles.length ? Math.round(Number(s.style)) : 1;
    const desc = styles[k - 1]?.desc || '';
    out.push({
      n,
      style: k,
      title: clean(s?.title, 80) || `Cảnh ${n}`,
      prompt: body ? `${body}${desc ? ' ' + desc : ''}${tail}`.trim() : '',
      file: `scene-${String(n).padStart(pad, '0')}_${slug(s?.file || s?.title)}`,
    });
  }
  return { scenes: out, model: r.model };
}

module.exports = { TOOLS, BATCH, MAX_STYLES, scenesOf, userStylesOf, guideStyles, styleGuide, scenePrompts };
