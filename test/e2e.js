'use strict';
// Test đầu-cuối bằng genmax giả lập: tạo dự án -> tải ảnh -> tạo voice+SRT -> dựng video -> kiểm tra file.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 3911;
const MOCK = 4911;
const MOCK_AI = 4912;
const BASE = `http://localhost:${PORT}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'gva-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => {
  console.log((c ? '  ✓ ' : '  ✗ ') + m);
  if (!c) failed++;
};

async function api(method, p, body) {
  const res = await fetch(BASE + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${j.error || ''}`);
  return j;
}

function mkImage(file, color, label) {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=1200x800`, '-vf', `drawtext=text='${label}':fontcolor=black:fontsize=120:x=(w-text_w)/2:y=(h-text_h)/2`, '-frames:v', '1', file]);
  if (r.status !== 0) throw new Error('không tạo được ảnh test: ' + r.stderr);
}

async function waitDone(id, label) {
  for (let i = 0; i < 600; i++) {
    const p = await api('GET', `/api/projects/${id}`);
    if (p.status === 'done' || p.status === 'error' || p.status === 'canceled') return p;
    await sleep(500);
  }
  throw new Error('timeout ' + label);
}

async function upload(id, file, kind = 'image') {
  const buf = fs.readFileSync(file);
  const res = await fetch(`${BASE}/api/projects/${id}/assets?kind=${kind}&name=${encodeURIComponent(path.basename(file))}`, { method: 'POST', body: buf });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error);
  return j.file;
}

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', file]);
  return JSON.parse(r.stdout.toString());
}

(async () => {
  const mock = spawn('node', [path.join(__dirname, 'mock-genmax.js')], { env: { ...process.env, MOCK_PORT: MOCK }, stdio: 'inherit' });
  const mockAi = spawn('node', [path.join(__dirname, 'mock-ai.js')], { env: { ...process.env, MOCK_AI_PORT: MOCK_AI }, stdio: 'inherit' });
  const aiBase = `http://127.0.0.1:${MOCK_AI}`;
  const srv = spawn('node', [path.join(ROOT, 'server.js')], { env: { ...process.env, PORT, GVA_DATA: data, GVA_ANTHROPIC_BASE: aiBase, GVA_GEMINI_BASE: aiBase }, stdio: 'inherit' });
  const cleanup = () => {
    mockAi.kill();
    mock.kill();
    srv.kill();
  };
  try {
    await sleep(1500);
    console.log('Settings');
    await api('PUT', '/api/settings', { apiKey: 'test-key-1234', baseUrl: `http://127.0.0.1:${MOCK}` });
    const s = await api('GET', '/api/settings');
    ok(s.apiKeySet && !('apiKey' in s) && s.apiKeyHint.endsWith('1234'), 'API key được ẩn khi trả về trình duyệt');
    const t = await api('POST', '/api/settings/test');
    ok(t.ok && t.credits === 123456, 'Kiểm tra key + đọc credit');
    ok((await api('GET', '/api/credits')).credits === 123456, 'Đọc số credit còn lại');
    const h = await api('GET', '/api/health');
    ok(h.ffmpeg.ok, 'FFmpeg sẵn sàng: ' + h.ffmpeg.version.slice(0, 30) + ' libass=' + h.ffmpeg.libass);
    const v = await api('GET', '/api/voices?source=el-default&search=a');
    ok(v.voices?.length === 2 && v.voices[0].voiceId === 'mock_aria', 'Lấy danh sách giọng mặc định');
    const mEl = await api('GET', '/api/models');
    const mMm = await api('GET', '/api/models?provider=minimax');
    ok(mEl.length === 1 && mEl[0].id === 'eleven_multilingual_v2' && mMm.map((m) => m.id).join() === 'speech-2.8-hd,speech-2.8-turbo', 'Model theo nhà cung cấp (bỏ model không đọc được)');
    const sh = await api('GET', '/api/voices?source=el-shared&language=vi');
    ok(sh.voices.length === 1 && sh.voices[0].voiceId === 'mock_shared_vi' && sh.voices[0].clones === 10, 'Thư viện ElevenLabs lọc theo ngôn ngữ');
    const mm = await api('GET', '/api/voices?source=mm-system');
    const mc = await api('GET', '/api/voices?source=mm-cloned');
    const cc = await api('GET', '/api/voices?source=cc-system');
    ok(mm.voices[0].provider === 'minimax' && mc.voices.length === 1 && mc.voices[0].voiceId === 'clone-uuid-1' && cc.voices[0].provider === 'capcut' && !cc.voices[0].tags.includes('越南语'), 'Giọng MiniMax / clone / CapCut');
    await api('PUT', '/api/favorites', { voice: mm.voices[0], on: true });
    const fav = await api('GET', '/api/favorites');
    await api('PUT', '/api/favorites', { voice: mm.voices[0], on: false });
    ok(fav.length === 1 && fav[0].voiceId === '1000001' && (await api('GET', '/api/favorites')).length === 0, 'Bật / tắt giọng yêu thích');

    const tmpImg = fs.mkdtempSync(path.join(os.tmpdir(), 'gva-img-'));
    mkImage(path.join(tmpImg, 'a.png'), 'white', 'Anh 1');
    mkImage(path.join(tmpImg, 'b.jpg'), 'lightyellow', 'Anh 2');

    // ---- AI gợi ý hiệu ứng
    console.log('\nAI gợi ý hiệu ứng');
    const s2 = await api('PUT', '/api/settings', { anthropicKey: 'sk-ant-test-9999', aiProvider: 'anthropic', aiModelAnthropic: 'claude-opus-5-5' });
    ok(s2.anthropicKeySet && !('anthropicKey' in s2) && s2.anthropicKeyHint.endsWith('9999') && s2.apiKeySet, 'Key Claude được ẩn, key genmax vẫn giữ');
    const at = await api('POST', '/api/ai/test?provider=anthropic');
    const gt = await api('POST', '/api/ai/test?provider=gemini');
    ok(at.ok && at.count === 1 && !gt.ok && /Chưa nhập/.test(gt.message), 'Kiểm tra key AI (có key / chưa có key)');
    const gTyped = await api('POST', '/api/ai/test?provider=gemini', { key: 'gm-typed-1111' });
    const sNow = await api('GET', '/api/settings');
    ok(gTyped.ok && gTyped.unsaved && !sNow.geminiKeySet, 'Kiểm tra key đang gõ mà không lưu');
    await api('PUT', '/api/settings', { geminiKey: 'gm-del-2222' });
    const sDel = await api('PUT', '/api/settings', { clearGeminiKey: true });
    ok(!sDel.geminiKeySet && sDel.anthropicKeySet && sDel.apiKeySet, 'Xoá key Gemini, các key khác giữ nguyên');
    const am = await api('GET', '/api/ai/models?provider=anthropic');
    ok(am.length === 1 && am[0].id === 'claude-opus-5-5', 'Danh sách model Claude (chỉ model nhìn được ảnh)');
    const imgBuf = fs.readFileSync(path.join(tmpImg, 'a.png'));
    const sugg = async (q = '') => {
      const r = await fetch(BASE + '/api/ai/suggest' + q, { method: 'POST', body: imgBuf });
      const j = await r.json();
      if (!r.ok) throw new Error('suggest -> ' + r.status + ' ' + j.error);
      return j;
    };
    const fx1 = await sugg();
    ok(fx1.effects.join() === 'fire,dust' && fx1.fire.length === 1 && fx1.fire[0].x === 0.6 && fx1.ai?.model === 'claude-opus-5-5', 'Claude gợi ý: lọc hiệu ứng lạ + toạ độ sai');
    ok(/đống lửa/.test(fx1.ai?.desc || ''), 'Kèm mô tả ảnh (để xếp theo kịch bản)');
    const c1 = await (await fetch(`http://127.0.0.1:${MOCK_AI}/calls`)).json();
    ok(c1.last.format === 'json_schema' && c1.last.effort === 'low' && c1.last.fallbacks === 'default' && /server-side-fallback/.test(c1.last.beta) && c1.last.image === 'image/jpeg', 'Gửi ảnh JPEG thu nhỏ + structured output + fallback');
    const fx2 = await sugg();
    const c2 = await (await fetch(`http://127.0.0.1:${MOCK_AI}/calls`)).json();
    ok(fx2.cached && c2.claude === c1.claude, 'Ảnh đã gợi ý thì không gọi AI lần hai');
    await api('PUT', '/api/settings', { aiModelAnthropic: 'slow-model' });
    const stopAc = new AbortController();
    setTimeout(() => stopAc.abort(), 400);
    const stopped = await fetch(BASE + '/api/ai/suggest', { method: 'POST', body: fs.readFileSync(path.join(tmpImg, 'b.jpg')), signal: stopAc.signal }).then(() => 'xong', (e) => e.name);
    await sleep(800);
    const c3 = await (await fetch(`http://127.0.0.1:${MOCK_AI}/calls`)).json();
    ok(stopped === 'AbortError' && c3.aborted === 1, 'Bấm Dừng: server huỷ luôn lời gọi AI đang chạy');
    await api('PUT', '/api/settings', { aiModelAnthropic: 'claude-opus-5-5' });
    await api('PUT', '/api/settings', { geminiKey: 'gm-test-8888', aiProvider: 'gemini' });
    const gm = await api('GET', '/api/ai/models?provider=gemini');
    ok(gm.length === 1 && gm[0].id === 'gemini-4-argon', 'Danh sách model Gemini (bỏ model không tạo nội dung)');
    await api('PUT', '/api/settings', { aiModelGemini: 'gemini-4-argon' });
    const fx3 = await sugg();
    ok(fx3.effects.join() === 'rain' && fx3.ai?.provider === 'gemini', 'Gemini gợi ý hiệu ứng');
    await api('PUT', '/api/settings', { aiProvider: 'anthropic' });

    const script =
      'Ngày xửa ngày xưa, loài người đã biết dùng lửa để nấu chín thức ăn. Đây là một bước ngoặt rất lớn trong lịch sử. ' +
      'Nhờ lửa, họ có thể sống sót qua mùa đông lạnh giá, và xua đuổi thú dữ vào ban đêm. ' +
      'Sau hàng trăm nghìn năm, con người bắt đầu vẽ lên vách hang những hình ảnh về cuộc sống của mình. ' +
      'Đó là những dấu vết đầu tiên của nghệ thuật. Còn bạn thì sao, bạn nghĩ điều gì quan trọng hơn cả?';

    // ---- Kịch bản 1: 16:9, 720p, 2 ảnh, phụ đề vàng
    console.log('\nKịch bản 1: 16:9 720p, 2 ảnh');
    let p = await api('POST', '/api/projects');
    const f1 = await upload(p.id, path.join(tmpImg, 'a.png'));
    const f2 = await upload(p.id, path.join(tmpImg, 'b.jpg'));
    const data1 = { title: 'Test lửa', script, images: [f1, f2], options: { orientation: 'landscape', resolution: 720, fps: 24, motion: 'mixed', maxScene: 6, captions: { on: true, preset: 'bold' }, voice: { provider: 'elevenlabs', voiceId: 'mock_aria', languageCode: 'vi' } } };
    await api('POST', `/api/projects/${p.id}/run`, { action: 'voice', data: data1 });
    p = await waitDone(p.id, 'voice');
    ok(p.status === 'done' && p.files.audio && p.files.srt, 'Tạo voice + SRT xong (nguồn SRT: ' + p.srtSource + ')');
    const srt = await (await fetch(BASE + p.srtUrl)).text();
    ok(/-->/.test(srt) && srt.includes('lửa'), 'SRT có nội dung tiếng Việt');
    ok(p.srtSource === 'genmax', 'Dùng SRT từ genmax');
    await api('POST', `/api/projects/${p.id}/run`, { action: 'video', data: data1 });
    p = await waitDone(p.id, 'video');
    ok(p.status === 'done' && p.files.video, 'Dựng video xong' + (p.error ? ': ' + p.error : ''));
    ok(p.startedAt && p.finishedAt && Date.parse(p.finishedAt) >= Date.parse(p.startedAt), 'Có thời điểm bắt đầu / hoàn thành');
    const file1 = path.join(data, 'projects', p.id, 'output.mp4');
    const i1 = probe(file1);
    const vs = i1.streams.find((x) => x.codec_type === 'video');
    ok(vs && vs.width === 1280 && vs.height === 720, `Kích thước 1280x720 (thực tế ${vs?.width}x${vs?.height})`);
    ok(i1.streams.some((x) => x.codec_type === 'audio'), 'Có luồng âm thanh');
    ok(Math.abs(Number(i1.format.duration) - p.audioDuration - 0.6) < 0.4, `Độ dài video ≈ giọng + 0.6s (${i1.format.duration}s vs ${p.audioDuration.toFixed(2)}s)`);
    spawnSync('ffmpeg', ['-y', '-v', 'error', '-ss', '3', '-i', file1, '-frames:v', '1', '/tmp/gva_shot1.png']);

    // ---- Xếp ảnh theo kịch bản
    console.log('\nXếp ảnh theo kịch bản');
    const { blocks } = await api('POST', '/api/story/blocks', { script });
    ok(blocks.length >= 2 && blocks.join(' ').replace(/\s+/g, ' ') === script.trim().replace(/\s+/g, ' '), `Chia kịch bản thành ${blocks.length} đoạn, không mất chữ`);
    const sb = await api('POST', '/api/ai/storyboard', { script, images: [{ name: 'fire.png', desc: 'lửa' }, { name: 'cake.png', desc: 'bánh sinh nhật' }, { name: 'x.png', desc: '' }] });
    ok(sb.blocks.length === blocks.length && sb.assign.length === blocks.length && sb.assign.every((i) => i === 0 || i === 1) && sb.unused.join() === '2' && sb.weak.join() === '1', 'AI ghép ảnh với từng đoạn + lọc ảnh không dùng');
    // prompt tạo ảnh cho từng cảnh
    const noStyle = await fetch(BASE + '/api/prompts/style', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ script, style: '  ', aspect: '16:9' }) });
    ok(noStyle.status === 400, 'Prompt ảnh: bắt buộc nhập phong cách');
    const g = await api('POST', '/api/prompts/style', { script, style: 'người que', aspect: '16:9' });
    ok(g.count === blocks.length && g.texts.length === blocks.length && g.styles.length === 1 && /No text/.test(g.styles[0].desc) && g.characters[0]?.name === 'Bà Gù', 'Prompt ảnh: phong cách chung + nhân vật');
    const sc = await api('POST', '/api/prompts/scenes', { script, from: 1, to: g.count, guide: g, tool: 'midjourney', aspect: '16:9' });
    ok(
      sc.scenes.length === g.count && sc.scenes[0].file === 'scene-01_cave-fire' && sc.scenes[0].prompt.includes('2D cartoon') && sc.scenes[0].prompt.endsWith('--ar 16:9'),
      'Prompt ảnh từng cảnh: tên file scene-NN + ghép phong cách + đuôi Midjourney',
    );
    const g2 = await api('POST', '/api/prompts/style', { script, styles: [{ text: 'người que', when: 'hiện tại' }, { text: 'tranh hang động' }, { text: '  ' }], aspect: '16:9' });
    ok(g2.styles.length === 2 && g2.styles[1].label === 'tranh hang động' && /cave painting/.test(g2.styles[1].desc), 'Prompt ảnh: nhiều phong cách (bỏ ô trống)');
    const sc2 = await api('POST', '/api/prompts/scenes', { script, from: 1, to: g2.count, guide: g2, tool: 'gemini', aspect: '16:9' });
    ok(sc2.scenes[0].style === 1 && sc2.scenes[0].prompt.includes('2D cartoon') && (sc2.scenes.length < 2 || (sc2.scenes[1].style === 2 && sc2.scenes[1].prompt.includes('cave painting') && !sc2.scenes[1].prompt.includes('2D cartoon'))), 'Prompt ảnh: AI chọn phong cách cho từng cảnh, ghép đúng phong cách');
    const legacy = await api('POST', '/api/prompts/scenes', { script, from: 1, to: 1, guide: { count: g.count, style: 'OLD STYLE' }, tool: 'gemini', aspect: '16:9' });
    ok(legacy.scenes[0].prompt.includes('OLD STYLE'), 'Prompt ảnh: dữ liệu cũ (1 phong cách dạng chuỗi) vẫn chạy');
    const stale = await fetch(BASE + '/api/prompts/scenes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ script: script + ' Thêm một câu rất dài để chắc chắn số đoạn kịch bản thay đổi so với lúc trước nhé, thêm nữa thêm nữa thêm nữa thêm nữa thêm nữa thêm nữa thêm nữa.', from: 1, to: 1, guide: { count: g.count }, tool: 'gemini' }) });
    ok(stale.status === 409, 'Kịch bản đổi số cảnh -> báo tạo lại');
    // dựng lại: đoạn đầu dùng ảnh 2, phần còn lại dùng ảnh 1
    const color = (file, t) => {
      const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'crop=40:40:300:80,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      return [...r.stdout];
    };
    const data1b = { ...data1, storyboard: { assign: blocks.map((_, i) => (i === 0 ? f2 : f1)) } };
    await api('POST', `/api/projects/${p.id}/run`, { action: 'video', data: data1b });
    p = await waitDone(p.id, 'video1b');
    const c0 = color(file1, 0.5);
    const cEnd = color(file1, p.audioDuration - 0.5);
    ok(p.status === 'done' && p.logs.some((l) => /Xếp ảnh theo kịch bản: \d+ đoạn/.test(l.msg)) && c0[2] < cEnd[2] - 5, `Dựng theo bảng: đầu video là ảnh 2 (vàng), cuối là ảnh 1 (trắng) — B ${c0[2]} vs ${cEnd[2]}`);
    ok(p.storyboard?.n === blocks.length, 'Lưu bảng xếp vào dự án');
    await api('PUT', `/api/projects/${p.id}`, { scenePrompts: { script, tool: 'gemini', count: g.count, styles: g2.styles, characters: g.characters, texts: g.texts, scenes: sc.scenes } });
    const pp = await api('GET', `/api/projects/${p.id}`);
    ok(pp.scenePrompts?.scenes?.length === g.count && pp.scenePrompts.scenes[0].file === 'scene-01_cave-fire' && pp.scenePrompts.styles.length === 2, 'Lưu prompt ảnh vào dự án');

    // ---- Kịch bản 2: 9:16, 1080p, 1 ảnh, cover, phụ đề hộp, nhạc nền, dùng lại voice
    console.log('\nKịch bản 2: 9:16 1080p, 1 ảnh, nhạc nền');
    spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=5', path.join(tmpImg, 'm.mp3')]);
    p = await api('POST', '/api/projects');
    const g1 = await upload(p.id, path.join(tmpImg, 'a.png'));
    const bg = await upload(p.id, path.join(tmpImg, 'm.mp3'), 'bgm');
    const data2 = { script: script.split('. ').slice(0, 2).join('. ') + '.', images: [g1], imageFx: { [g1]: { effects: ['fire', 'rain', 'snow', 'fog', 'dust', 'bogus'], fire: [{ x: 0.5, y: 0.7 }] } }, bgm: bg, options: { orientation: 'portrait', resolution: 1080, fps: 30, fit: 'cover', motion: 'zoom', transition: 'fade', maxScene: 4, captions: { on: true, preset: 'box', position: 'middle', uppercase: true }, voice: { provider: 'elevenlabs', voiceId: 'mock_roger' } } };
    await api('POST', `/api/projects/${p.id}/run`, { action: 'video', data: data2 }); // tự tạo voice rồi dựng luôn
    p = await waitDone(p.id, 'video2');
    ok(p.status === 'done' && p.files.video, 'Chạy một lần: voice + video' + (p.error ? ': ' + p.error : ''));
    ok(p.imageFx?.[g1]?.effects.join() === 'fire,rain,snow,fog,dust' && p.logs.some((l) => /Hiệu ứng phủ trên 1\/1/.test(l.msg)), 'Dựng video có hiệu ứng phủ (bỏ hiệu ứng lạ)');
    const file2 = path.join(data, 'projects', p.id, 'output.mp4');
    const i2 = probe(file2);
    const vs2 = i2.streams.find((x) => x.codec_type === 'video');
    ok(vs2 && vs2.width === 1080 && vs2.height === 1920, `Kích thước 1080x1920 (thực tế ${vs2?.width}x${vs2?.height})`);
    spawnSync('ffmpeg', ['-y', '-v', 'error', '-ss', '2', '-i', file2, '-frames:v', '1', '/tmp/gva_shot2.png']);

    // ---- Kịch bản 3: chỉ đổi tuỳ chọn hình -> không tạo lại giọng
    console.log('\nKịch bản 3: đổi tuỳ chọn hình, giọng giữ nguyên');
    const before = p.voiceHash;
    data2.options.resolution = 480;
    data2.options.captions.on = false;
    await api('POST', `/api/projects/${p.id}/run`, { action: 'video', data: data2 });
    p = await waitDone(p.id, 'video3');
    ok(p.status === 'done' && p.voiceHash === before && !p.logs.slice(-6).some((l) => /task genmax/.test(l.msg) && false), 'Dựng lại không tốn thêm credit giọng');
    const calls = p.logs.filter((l) => /task genmax/.test(l.msg)).length;
    ok(calls === 1, `Chỉ gọi genmax đúng 1 lần cho dự án này (đếm: ${calls})`);

    // ---- Bảo mật
    console.log('\nBảo mật');
    const bad = await fetch(BASE + '/api/settings', { headers: { Origin: 'http://evil.example' } });
    ok(bad.status === 403, 'Chặn Origin lạ');
    const badStatus = await new Promise((resolve) => {
      const r = require('http').request({ host: '127.0.0.1', port: PORT, path: '/api/settings', headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      r.on('error', () => resolve(0));
      r.end();
    });
    ok(badStatus === 403, 'Chặn Host lạ (chống DNS rebinding)');
    const trav = await fetch(BASE + `/files/${p.id}/..%2Fproject.json`);
    ok(trav.status === 404, 'Không đọc được file ngoài danh sách cho phép');

    // ---- Huỷ + xoá
    console.log('\nDọn dẹp');
    await api('DELETE', `/api/projects/${p.id}`);
    const list = await api('GET', '/api/projects');
    ok(!list.some((x) => x.id === p.id), 'Xoá dự án');
  } catch (e) {
    console.error('LỖI:', e);
    failed++;
  } finally {
    cleanup();
  }
  console.log(failed ? `\n${failed} kiểm tra thất bại` : '\nTất cả kiểm tra đều đạt');
  process.exit(failed ? 1 : 0);
})();
