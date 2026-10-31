'use strict';
// Giả lập API genmax.io để thử app mà không tốn credit.
// Chạy: npm run mock   -> trong Settings đặt Base URL = http://127.0.0.1:4010 và API key bất kỳ.
// Giọng "đọc" chỉ là âm thanh bíp có độ dài tỉ lệ với số ký tự.
const http = require('http');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.MOCK_PORT) || 4010;
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const NO_SRT = process.env.NO_SRT === '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-genmax-'));
const tasks = new Map();
let n = 0;

function fmt(t) {
  const ms = Math.round(t * 1000);
  const p = (x, l = 2) => String(x).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor((ms % 3600000) / 60000))}:${p(Math.floor((ms % 60000) / 1000))},${p(ms % 1000, 3)}`;
}

function makeSrt(text, dur) {
  const sents = text.split(/(?<=[.!?…])\s+/).filter(Boolean);
  const total = sents.reduce((a, s) => a + s.length, 0) || 1;
  let t = 0;
  return sents
    .map((s, i) => {
      const d = (dur * s.length) / total;
      const out = `${i + 1}\n${fmt(t)} --> ${fmt(t + d)}\n${s}\n`;
      t += d;
      return out;
    })
    .join('\n');
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (code, o) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  if (u.pathname.startsWith('/audio/') || u.pathname.startsWith('/srt/')) {
    const f = path.join(tmp, path.basename(u.pathname));
    if (!fs.existsSync(f)) return json(404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': f.endsWith('.mp3') ? 'audio/mpeg' : 'text/plain' });
    return fs.createReadStream(f).pipe(res);
  }
  if (!req.headers['xi-api-key']) return json(401, { detail: 'Missing xi-api-key' });

  if (req.method === 'GET' && u.pathname === '/v1/default-voices') {
    return json(200, {
      voices: [
        { voice_id: 'mock_aria', name: 'Aria (mock)', description: 'Giọng thử nghiệm', preview_url: '', gender: 'female', accent: 'american', language: 'en' },
        { voice_id: 'mock_roger', name: 'Roger (mock)', description: 'Giọng thử nghiệm', preview_url: '', gender: 'male', accent: 'british', language: 'en' },
      ],
      has_more: false,
    });
  }
  if (req.method === 'GET' && u.pathname === '/v1/auth/me') return json(200, { id: 'u1', credit_balance: 123456, role: 'user' });
  if (req.method === 'GET' && u.pathname === '/v1/models') {
    const p = u.searchParams.get('provider');
    if (p === 'minimax') return json(200, [{ model_id: 'speech-2.8-hd', name: 'Speech 2.8 HD', credit_ratio: 1 }, { model_id: 'speech-2.8-turbo', name: 'Speech 2.8 Turbo', credit_ratio: 0.6 }]);
    if (p === 'capcut') return json(200, [{ model_id: 'capcut', name: 'CapCut', credit_ratio: 0.1 }]);
    return json(200, [
      { model_id: 'eleven_multilingual_v2', name: 'Eleven Multilingual v2', can_do_text_to_speech: true },
      { model_id: 'eleven_multilingual_sts_v2', name: 'Eleven Multilingual STS v2', can_do_text_to_speech: false },
    ]);
  }
  if (req.method === 'GET' && u.pathname === '/v1/languages') {
    return json(200, u.searchParams.get('provider') === 'minimax' ? [{ code: 'Vietnamese', name: 'Vietnamese' }] : [{ code: 'vi', name: 'Vietnamese' }, { code: 'en', name: 'English' }]);
  }
  if (req.method === 'GET' && u.pathname === '/v1/shared-voices') {
    const lang = u.searchParams.get('required_languages');
    const all = [
      { voice_id: 'mock_shared_vi', name: 'Mai (mock)', accent: 'northern', gender: 'female', age: 'young', language: 'vi', cloned_by_count: 10, usage_character_count_1y: 5000 },
      { voice_id: 'mock_shared_en', name: 'Sam (mock)', accent: 'american', gender: 'male', age: 'young', language: 'en', cloned_by_count: 3, usage_character_count_1y: 900 },
    ];
    return json(200, { voices: all.filter((v) => !lang || v.language === lang), has_more: false });
  }
  if (req.method === 'GET' && u.pathname === '/v1/minimax/system-voices') {
    return json(200, { voice_list: [{ voice_id: '1000001', voice_name: 'Minh (mock)', tag_list: ['Vietnamese', 'Standard', 'Male', 'Young'], sample_audio: '' }], total: 1, has_more: false });
  }
  if (req.method === 'GET' && u.pathname === '/v1/minimax/voices') return json(200, { voices: [{ id: 'clone-uuid-1', voice_name: 'Giọng clone (mock)', status: 'done', language_tag: 'Vietnamese' }, { id: 'clone-uuid-2', voice_name: 'Đang xử lý', status: 'processing' }] });
  if (req.method === 'GET' && u.pathname === '/v1/capcut/system-voices') {
    return json(200, { voice_list: [{ voice_id: '2000001', name: 'Cute Female (mock)', language: 'vi', gender: 'female', tags: ['越南语', 'narration'] }], total: 1, has_more: false });
  }

  let m = /^\/v1\/text-to-speech\/([^/]+)$/.exec(u.pathname);
  if (req.method === 'POST' && m) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (!body.text || !body.language_code) return json(422, { detail: 'text and language_code are required' });
      const id = `task-${++n}`;
      const dur = Math.max(1.5, body.text.length / 14);
      const mp3 = path.join(tmp, id + '.mp3');
      const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=330:duration=${dur.toFixed(2)}`, '-af', 'volume=0.2', mp3]);
      if (r.status !== 0) return json(500, { detail: 'mock ffmpeg failed' });
      if (body.export_transcript && !NO_SRT) fs.writeFileSync(path.join(tmp, id + '.srt'), makeSrt(body.text, dur));
      tasks.set(id, { polls: 0, text: body.text, srt: !!body.export_transcript && !NO_SRT, body });
      json(202, { id, status: 'pending' });
    });
    return;
  }
  m = /^\/v1\/history\/([^/]+)$/.exec(u.pathname);
  if (req.method === 'GET' && m) {
    const t = tasks.get(m[1]);
    if (!t) return json(404, { detail: 'not found' });
    t.polls++;
    if (t.polls < 3) return json(200, { id: m[1], status: t.polls === 1 ? 'pending' : 'processing', progress: t.polls * 30, result: null, error: null });
    const result = { audio_url: `http://127.0.0.1:${PORT}/audio/${m[1]}.mp3` };
    if (t.srt) result.srt_url = `http://127.0.0.1:${PORT}/srt/${m[1]}.srt`;
    return json(200, { id: m[1], status: 'completed', progress: 100, text: t.text, result, error: null, characters_used: t.text.length });
  }
  json(404, { detail: 'unknown endpoint ' + u.pathname });
});

server.listen(PORT, '127.0.0.1', () => console.log(`Mock genmax chạy tại http://127.0.0.1:${PORT}`));
