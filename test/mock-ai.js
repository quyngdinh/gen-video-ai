'use strict';
// Giả lập API Claude + Gemini cho test (không tốn tiền). Trả gợi ý hiệu ứng cố định.
const http = require('http');

const PORT = Number(process.env.MOCK_AI_PORT) || 4012;
const calls = { claude: 0, gemini: 0, last: null };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (code, o) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  const body = () =>
    new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')));
    });
  if (u.pathname === '/calls') return json(200, calls);

  // ---- Claude
  if (u.pathname.startsWith('/v1/')) {
    if (!req.headers['x-api-key'] || !req.headers['anthropic-version']) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    if (req.method === 'GET' && u.pathname === '/v1/models') {
      return json(200, {
        data: [
          { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', capabilities: { image_input: { supported: true }, structured_outputs: { supported: true }, effort: { supported: true, low: { supported: true } } } },
          { id: 'claude-text-only', display_name: 'Text only', capabilities: { image_input: { supported: false } } },
        ],
        has_more: false,
        last_id: 'claude-text-only',
      });
    }
    if (req.method === 'POST' && u.pathname === '/v1/messages') {
      return body().then((b) => {
        calls.claude++;
        if (b.model === 'slow-model') {
          // model chậm: dùng để test nút Dừng (server phải huỷ kết nối tới AI)
          let finished = false;
          res.on('close', () => !finished && (calls.aborted = (calls.aborted || 0) + 1));
          return setTimeout(() => {
            finished = true;
            if (!res.destroyed) json(200, { model: b.model, stop_reason: 'end_turn', content: [{ type: 'text', text: '{"effects":[],"fire":[],"reason":"chậm"}' }] });
          }, 3000);
        }
        calls.last = { model: b.model, beta: req.headers['anthropic-beta'] || '', fallbacks: b.fallbacks, format: b.output_config?.format?.type, effort: b.output_config?.effort, image: b.messages?.[0]?.content?.[0]?.source?.media_type };
        const parts = b.messages?.[0]?.content || [];
        const text = parts.map((p) => p.text || '').join('');
        // video nhạc: AI xem clip / xếp clip theo câu hát
        if (text.startsWith('[task: music-clip]')) {
          calls.musicClip = (calls.musicClip || 0) + 1;
          if (parts[0]?.type !== 'image') return json(400, { type: 'error', error: { message: 'missing image' } });
          return json(200, { model: b.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ desc: 'Chú cò trắng bay trên cánh đồng lúa', tags: ['cò', 'cánh đồng'], energy: 2 + (calls.musicClip % 3), mood: 'êm dịu' }) }] });
        }
        if (text.startsWith('[task: music-arrange]')) {
          calls.musicArrange = (calls.musicArrange || 0) + 1;
          const nl = Number(/Lời có (\d+) câu/.exec(text)?.[1]);
          const nc = Number(/Có (\d+) clip/.exec(text)?.[1]);
          // câu i -> clip (i mod nc)+1; chừa clip cuối không dùng nếu có ≥ 3 clip
          const use = nc >= 3 ? nc - 1 : nc;
          const lines = [...Array(nl)].map((_, i) => ({ clip: (i % use) + 1 }));
          return json(200, { model: b.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ intro: use, lines, unused: nc >= 3 ? [nc] : [], notes: 'Xếp theo lời' }) }] });
        }
        if (parts[0]?.type !== 'image') {
          // ghép ảnh với kịch bản: đọc số đoạn / số ảnh trong prompt, chừa ảnh cuối không dùng
          const prompt = parts.map((p) => p.text || '').join('');
          if (prompt.startsWith('[task: visual-bible]')) {
            calls.style = (calls.style || 0) + 1;
            return json(200, { model: b.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ styles: [{ n: 1, desc: '2D cartoon stick figures, thick black outlines, warm palette. No text, letters or watermarks in the image.', use: 'hiện tại' }, ...(/2 phong cách/.test(prompt) ? [{ n: 2, desc: 'Prehistoric cave painting, ochre pigments on rock. No text, letters or watermarks in the image.', use: 'hồi tưởng' }] : [])], characters: [{ name: 'Bà Gù', look: 'old hunched stick-figure woman, grey bun, brown fur cloak' }] }) }] });
          }
          if (prompt.startsWith('[task: scene-prompts]')) {
            calls.scenes = (calls.scenes || 0) + 1;
            const [, a, z] = /các cảnh (\d+)–(\d+)/.exec(prompt).map(Number);
            const scenes = [];
            for (let n = a; n <= z; n++) scenes.push({ n, style: /Có 2 phong cách/.test(prompt) ? (n % 2 ? 1 : 2) : 1, title: 'Cảnh thử ' + n, prompt: `A stick figure scene number ${n} inside a dark cave`, file: n === a ? 'Cave Fire!' : 'cave-scene' });
            return json(200, { model: b.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ scenes }) }] });
          }
          const nb = Number(/thành (\d+) đoạn/.exec(prompt)?.[1]);
          const ni = Number(/có (\d+) ảnh/.exec(prompt)?.[1]);
          if (!nb || !ni) return json(400, { type: 'error', error: { message: 'missing image' } });
          calls.story = (calls.story || 0) + 1;
          const assign = [...Array(nb)].map((_, i) => (ni > 1 ? (i % (ni - 1)) + 1 : 1));
          return json(200, { model: b.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ assign, unused: [ni], weak: [2], notes: 'Xếp theo diễn biến' }) }] });
        }
        json(200, {
          model: b.model,
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify({ effects: ['fire', 'dust', 'bogus'], fire: [{ x: 0.6, y: 0.8 }, { x: 2, y: 0.5 }], reason: 'Có đống lửa trong hang tối', desc: 'Người que ngồi bên đống lửa trong hang' }) }],
        });
      });
    }
  }

  // ---- Gemini
  if (u.pathname.startsWith('/v1beta/')) {
    if (!req.headers['x-goog-api-key']) return json(403, { error: { message: 'API key not valid' } });
    if (req.method === 'GET' && u.pathname === '/v1beta/models') {
      return json(200, {
        models: [
          { name: 'models/gemini-4-argon', displayName: 'Gemini 4 Argon', supportedGenerationMethods: ['generateContent', 'countTokens'] },
          { name: 'models/text-embedding-005', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
        ],
      });
    }
    if (req.method === 'POST' && /^\/v1beta\/models\/[^/]+:generateContent$/.test(u.pathname)) {
      return body().then((b) => {
        calls.gemini++;
        const gparts = b.contents?.[0]?.parts || [];
        const gtext = gparts.map((p) => p.text || '').join('');
        // video nhạc: AI nghe bài hát -> thời gian từng câu. Câu i hát lúc 2 + 3i giây; câu 3 trả dạng "m:ss.xx";
        // câu 4 cố tình lùi về trước (app phải bỏ), câu cuối trả theo số n đảo thứ tự
        // AI tự chép lời: 5 câu + 1 câu trùng thời gian (app phải bỏ) + nhãn [Điệp khúc] (app phải xoá)
        if (gtext.startsWith('[task: music-transcribe]')) {
          calls.musicTranscribe = (calls.musicTranscribe || 0) + 1;
          if (gparts[0]?.inline_data?.mime_type !== 'audio/mp3') return json(400, { error: { message: 'missing audio' } });
          const lines = [
            { text: 'Con cò bé bé', start: 2.1, end: 4.5 },
            { text: 'Nó đậu cành tre', start: '0:05.00', end: 7.5 },
            { text: 'Đi không hỏi mẹ', start: 8.1, end: 11 },
            { text: 'Câu trùng giờ', start: 8.1, end: 9 },
            { text: '[Điệp khúc] Con cò bé bé', start: 12, end: 14.5 },
            { text: 'Biết đi đường nào', start: 15.2, end: 18 },
          ];
          return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({ title: 'Con cò bé bé', lines, notes: 'Lời rõ' }) }] } }] });
        }
        // mốc các đoạn: có nhãn -> đoạn i bắt đầu lúc 2i giây, đoạn 3 trả "m:ss", đoạn 4 lùi về trước (app lấy từ bảng câu hát hoặc bỏ);
        // không nhãn -> AI tự chia 3 đoạn
        if (gtext.startsWith('[task: music-sections]')) {
          calls.musicSections = (calls.musicSections || 0) + 1;
          if (gparts[0]?.inline_data?.mime_type !== 'audio/mp3') return json(400, { error: { message: 'missing audio' } });
          const n = Number(/chia thành (\d+) đoạn/.exec(gtext)?.[1]);
          const sections = n
            ? [...Array(n)].map((_, i) => ({ n: i + 1, label: 'x', start: i === 2 ? '0:04.50' : i === 3 ? 1 : 2 * i, first: '' }))
            : [{ n: 1, label: 'Intro', start: 0 }, { n: 2, label: 'Verse 1 - soft', start: 2.1, first: 'Con cò' }, { n: 3, label: 'Final Chorus', start: 12 }];
          return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({ sections, notes: 'Nghe rõ' }) }] } }] });
        }
        if (gtext.startsWith('[task: music-align]')) {
          calls.musicAlign = (calls.musicAlign || 0) + 1;
          if (gparts[0]?.inline_data?.mime_type !== 'audio/mp3' || !gparts[0].inline_data.data) return json(400, { error: { message: 'missing audio' } });
          const n = Number(/gồm (\d+) câu/.exec(gtext)?.[1]);
          const lines = [...Array(n)].map((_, i) => ({ n: i + 1, start: i === 2 ? `0:0${2 + 3 * i}.50` : i === 3 ? 1 : 2 + 3 * i, end: 4 + 3 * i }));
          if (lines.length > 1) lines.push(lines.splice(0, 1)[0]);
          return json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({ lines, notes: 'Nghe rõ' }) }] } }] });
        }
        if (!gparts[0]?.inline_data?.data) return json(400, { error: { message: 'missing image' } });
        json(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({ effects: ['rain'], fire: [], reason: 'Trời đang mưa' }) }] } }] });
      });
    }
  }
  json(404, { error: { message: 'unknown ' + u.pathname } });
});

server.listen(PORT, '127.0.0.1', () => console.log(`Mock Claude/Gemini chạy tại http://127.0.0.1:${PORT}`));
