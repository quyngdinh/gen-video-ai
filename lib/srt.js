'use strict';
// Xử lý văn bản kịch bản, SRT và ASS (phụ đề đốt vào video).

function parseTime(s) {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s);
  if (!m) return NaN;
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + Number('0.' + m[4]);
}

function fmtTime(t, sep = ',') {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(r, 3)}`;
}

function parseSrt(text) {
  const cues = [];
  const blocks = String(text).replace(/\r/g, '').replace(/^﻿/, '').split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trim()).filter((l, i, a) => l !== '' || i < a.length);
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, c] = lines[ti].split('-->');
    const start = parseTime(a);
    const end = parseTime(c);
    if (!isFinite(start) || !isFinite(end)) continue;
    const txt = lines
      .slice(ti + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (txt) cues.push({ start, end, text: txt });
  }
  return cues;
}

function buildSrt(cues) {
  return (
    cues.map((c, i) => `${i + 1}\n${fmtTime(c.start)} --> ${fmtTime(c.end)}\n${c.text}\n`).join('\n')
  );
}

function shiftCues(cues, offset) {
  return cues.map((c) => ({ ...c, start: c.start + offset, end: c.end + offset }));
}

/** Tách câu, không làm mất ký tự (an toàn với "3.5", "TP.HCM"). */
function splitSentences(text) {
  const out = [];
  for (const para of String(text).replace(/\r/g, '').split(/\n+/)) {
    const t = para.trim();
    if (!t) continue;
    for (const s of t.split(/(?<=[.!?…。！？]["”’')\]]*)\s+/)) {
      const x = s.trim();
      if (x) out.push(x);
    }
  }
  return out;
}

function hardSplit(s, max) {
  const out = [];
  let cur = '';
  for (const w of s.split(/\s+/)) {
    if (cur && (cur + ' ' + w).length > max) {
      out.push(cur);
      cur = w;
    } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) out.push(cur);
  return out;
}

/** Gom các câu thành các khối ≤ max ký tự (để gửi từng request TTS). */
function chunkText(text, max) {
  const chunks = [];
  let cur = '';
  const push = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = '';
  };
  for (const s of splitSentences(text)) {
    const parts = s.length > max ? hardSplit(s, max) : [s];
    for (const p of parts) {
      if (cur && (cur + ' ' + p).length > max) push();
      cur = cur ? cur + ' ' + p : p;
    }
  }
  push();
  return chunks;
}

/**
 * Chia kịch bản thành các đoạn để gán ảnh: gom câu liền nhau tới ~180 ký tự (~15 giây đọc),
 * kịch bản dài thì đoạn dài hơn để tổng số đoạn không quá ~150.
 * Trả về [{ text, a, b }] với a, b là vị trí ký tự trong chuỗi các câu nối bằng một dấu cách.
 */
function storyBlocks(text, maxBlocks = 150) {
  const sents = splitSentences(text);
  const total = sents.reduce((n, x) => n + x.length + 1, 0);
  const min = Math.max(180, Math.ceil(total / maxBlocks));
  const blocks = [];
  let cur = [];
  let len = 0;
  let pos = 0;
  let start = 0;
  const push = () => {
    if (!cur.length) return;
    blocks.push({ text: cur.join(' '), a: start, b: pos });
    cur = [];
    len = 0;
    start = pos;
  };
  for (const x of sents) {
    cur.push(x);
    len += x.length + 1;
    pos += x.length + 1;
    if (len >= min) push();
  }
  // đoạn cuối quá ngắn thì gộp vào đoạn trước
  if (cur.length && blocks.length && len < min / 3) {
    const last = blocks[blocks.length - 1];
    last.text += ' ' + cur.join(' ');
    last.b = pos;
  } else push();
  return blocks;
}

/** Không có SRT từ genmax: chia thời gian theo độ dài từng câu. */
function fallbackCues(text, duration) {
  const sents = splitSentences(text);
  const weights = sents.map((s) => s.length + 10);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = 0;
  return sents.map((s, i) => {
    const d = (duration * weights[i]) / total;
    const c = { start: t, end: t + d, text: s };
    t += d;
    return c;
  });
}

/** Cắt cue dài thành nhiều cue ngắn (ưu tiên ngắt sau dấu câu). */
function splitCaption(text, maxChars) {
  const words = text.split(/\s+/);
  const out = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (cur && next.length > maxChars) {
      out.push(cur);
      cur = w;
    } else {
      cur = next;
      if (/[,;:.!?…]$/.test(w) && cur.length >= maxChars * 0.55) {
        out.push(cur);
        cur = '';
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

function normalizeCues(cues, maxChars = 56) {
  const out = [];
  for (const c of cues) {
    if (c.text.length <= maxChars) {
      out.push(c);
      continue;
    }
    const pieces = splitCaption(c.text, maxChars);
    const total = pieces.reduce((a, p) => a + p.length, 0) || 1;
    let t = c.start;
    for (const p of pieces) {
      const d = ((c.end - c.start) * p.length) / total;
      out.push({ start: t, end: t + d, text: p });
      t += d;
    }
  }
  // không cho cue chồng nhau
  for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].end) out[i - 1].end = out[i].start;
  return out;
}

/** Tạo file ASS. Màu theo định dạng &HAABBGGRR. */
function toAss(cues, { w, h, font = 'Arial', sizeMul = 1, preset = 'classic', position = 'bottom', uppercase = false }) {
  const size = Math.round(Math.min(w, h) * 0.058 * sizeMul);
  const align = { bottom: 2, middle: 5, top: 8 }[position] || 2;
  const marginV = position === 'middle' ? 0 : Math.round(h * 0.07);
  const marginLR = Math.round(w * 0.06);
  const P = {
    classic: { primary: '&H00FFFFFF', outline: '&H00000000', back: '&H00000000', border: 1, ol: Math.max(2, Math.round(size * 0.07)), sh: 0 },
    bold: { primary: '&H0000DDFF', outline: '&H00000000', back: '&H00000000', border: 1, ol: Math.max(3, Math.round(size * 0.11)), sh: 0 },
    box: { primary: '&H00FFFFFF', outline: '&H50000000', back: '&H50000000', border: 3, ol: Math.max(6, Math.round(size * 0.28)), sh: 0 },
  }[preset] || null;
  const st = P || {};
  const t = (s) =>
    (uppercase ? s.toLocaleUpperCase('vi') : s)
      .replace(/[{}]/g, (m) => (m === '{' ? '(' : ')'))
      .replace(/\n/g, '\\N');
  const ass = (sec) => {
    const cs = Math.round(sec * 100);
    const hh = Math.floor(cs / 360000);
    const mm = Math.floor((cs % 360000) / 6000);
    const ss = Math.floor((cs % 6000) / 100);
    const c2 = cs % 100;
    return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(c2).padStart(2, '0')}`;
  };
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${font},${size},${st.primary},${st.primary},${st.outline},${st.back},-1,0,0,0,100,100,0,0,${st.border},${st.ol},${st.sh},${align},${marginLR},${marginLR},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const ev = cues.map((c) => `Dialogue: 0,${ass(c.start)},${ass(c.end)},Default,,0,0,0,,${t(c.text)}`);
  return head.concat(ev).join('\n') + '\n';
}

module.exports = {
  storyBlocks,
  parseSrt,
  buildSrt,
  shiftCues,
  splitSentences,
  chunkText,
  fallbackCues,
  normalizeCues,
  toAss,
  fmtTime,
};
