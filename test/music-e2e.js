'use strict';
// Test đầu-cuối mục Video nhạc: bài hát + clip video -> dò nhịp -> AI (giả lập) xem clip + xếp clip -> dựng video.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 3931;
const MOCK_AI = 4932;
const BASE = `http://localhost:${PORT}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'gva-music-'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gva-music-src-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => {
  console.log((c ? '  ✓ ' : '  ✗ ') + m);
  if (!c) failed++;
};

async function api(method, p, body, raw) {
  const res = await fetch(BASE + p, raw ? { method, body: raw } : { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${j.error || ''}`);
  return j;
}
const ff = (args) => {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args]);
  if (r.status !== 0) throw new Error('ffmpeg: ' + r.stderr);
};
function probe(file) {
  return JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', file]).stdout.toString());
}

(async () => {
  // bài hát 20s, 120 BPM (tiếng gõ mỗi 0.5s, bắt đầu 0.3s); 3 clip video + 1 ảnh
  const song = path.join(tmp, 'Bai hat.wav');
  ff(['-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*220*t)+0.8*exp(-40*mod(t+9.7\\,0.5))*sin(2*PI*1500*t)':s=44100:d=20", song]);
  const clips = [
    ['co-bay.mp4', 'testsrc2=s=640x360:r=25:d=3'],
    ['vit-boi.mov', 'testsrc=s=480x640:r=30:d=2'],
    ['ga-nhay.mp4', 'smptebars=s=640x360:r=25:d=6'],
  ].map(([n, src], i) => {
    const f = path.join(tmp, n);
    // clip đầu có tiếng (tiếng bíp 880Hz), các clip khác không có tiếng
    ff(['-f', 'lavfi', '-i', src, ...(i === 0 ? ['-f', 'lavfi', '-i', 'sine=f=880:d=3', '-shortest'] : []), '-pix_fmt', 'yuv420p', f]);
    return f;
  });
  const img = path.join(tmp, 'meo.png');
  ff(['-f', 'lavfi', '-i', 'color=c=pink:s=800x600', '-frames:v', '1', img]);

  // dự án video nhạc kiểu cũ (dùng ảnh) -> phải tự chuyển sang clip
  const legacy = 'abcdefabcdef';
  fs.mkdirSync(path.join(data, 'music', legacy, 'images'), { recursive: true });
  fs.copyFileSync(img, path.join(data, 'music', legacy, 'images', 'img_old1.png'));
  fs.writeFileSync(
    path.join(data, 'music', legacy, 'project.json'),
    JSON.stringify({ id: legacy, kind: 'music', title: 'Cũ', status: 'idle', progress: 0, logs: [], song: null, songName: '', songDuration: 0, lyricsRaw: '', lines: [{ text: 'A', start: 1, end: null, img: 'img_old1.png' }], images: ['img_old1.png'], imageNames: { 'img_old1.png': 'meo.png' }, imageFx: { 'img_old1.png': ['stars'] }, options: {}, files: { video: false }, updatedAt: '2026-01-01' }),
  );

  const mockAi = spawn('node', [path.join(__dirname, 'mock-ai.js')], { env: { ...process.env, MOCK_AI_PORT: MOCK_AI }, stdio: 'inherit' });
  const aiBase = `http://127.0.0.1:${MOCK_AI}`;
  const srv = spawn('node', [path.join(ROOT, 'server.js')], { env: { ...process.env, PORT, GVA_DATA: data, GVA_ANTHROPIC_BASE: aiBase, GVA_GEMINI_BASE: aiBase }, stdio: 'inherit' });
  const cleanup = () => {
    srv.kill();
    mockAi.kill();
    fs.rmSync(data, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  try {
    for (let i = 0; i < 40; i++) {
      try {
        await api('GET', '/api/health');
        break;
      } catch (_) {
        await sleep(250);
      }
    }
    await api('PUT', '/api/settings', { anthropicKey: 'sk-ant-test-1', aiProvider: 'anthropic', aiModelAnthropic: 'claude-opus-5-5' });

    console.log('\nDự án cũ (ảnh)');
    const old = await api('GET', `/api/music/${legacy}`);
    ok(old.clips?.[0] === 'img_old1.png' && old.clipInfo['img_old1.png'].kind === 'image' && old.lines[0].clip === 'img_old1.png' && old.clipFx['img_old1.png'][0] === 'stars' && !old.images, 'Tự chuyển ảnh sang danh sách clip, giữ gán câu + hiệu ứng');
    ok((await fetch(`${BASE}/mfiles/${legacy}/clips/img_old1.png`)).status === 200, 'Ảnh cũ vẫn tải được');

    console.log('\nTải bài hát + clip');
    const draft = await api('POST', '/api/music', { name: '' });
    ok(draft.name === '' && draft.title === '' && !draft.song && !draft.clips.length && !draft.lines.length, `Tạo dự án nháp chưa có tên, dữ liệu trống (${draft.id})`);
    ok((await fetch(`${BASE}/api/music/${draft.id}/run`, { method: 'POST', body: '{}' })).status === 400, 'Dự án nháp chưa có tên thì không dựng được');
    await api('DELETE', `/api/music/${draft.id}`);
    let p = await api('POST', '/api/music', { name: 'Con cò bé bé' });
    ok(p.id === 'con-co-be-be' && p.name === 'Con cò bé bé' && fs.existsSync(path.join(data, 'music', 'con-co-be-be', 'project.json')), `Thư mục dự án theo tên dự án (${p.id})`);
    ok((await api('POST', '/api/music', { name: 'Con cò bé bé' })).id === 'con-co-be-be-2', 'Trùng tên dự án thì đánh số thư mục');
    const s = await api('POST', `/api/music/${p.id}/assets?kind=song&name=${encodeURIComponent('Bai hat.wav')}`, null, fs.readFileSync(song));
    ok(Math.abs(s.project.songDuration - 20) < 0.2, `Đọc độ dài bài hát (${s.project.songDuration.toFixed(2)}s)`);
    const bpm = s.project.beats?.bpm;
    ok(bpm > 118 && bpm < 122, `Dò nhịp ~120 BPM (${bpm})`);
    const b0 = s.project.beats.beats;
    ok(b0.slice(1, 6).every((t, i) => Math.abs(t - (0.8 + i * 0.5)) < 0.06), 'Lưới phách khớp tiếng gõ');
    const files = [];
    for (const f of [...clips, img]) files.push((await api('POST', `/api/music/${p.id}/assets?kind=clip&name=${encodeURIComponent(path.basename(f))}`, null, fs.readFileSync(f))).file);
    p = await api('GET', `/api/music/${p.id}`);
    ok(p.clips.length === 4 && Math.abs(p.clipInfo[files[0]].dur - 3) < 0.1 && p.clipInfo[files[2]].kind === 'video' && p.clipInfo[files[3]].kind === 'image', 'Đọc thời lượng / loại từng clip');
    ok((await fetch(BASE + p.clipList[1].thumb)).status === 200, 'Có ảnh xem trước của clip');
    ok(p.clipInfo[files[0]].audio === true && p.clipInfo[files[1]].audio === false, 'Nhận ra clip nào có tiếng');
    ok(p.options.muteClips === true, 'Mặc định tắt tiếng mọi clip');
    const bad = await fetch(`${BASE}/api/music/${p.id}/assets?kind=clip&name=x.txt`, { method: 'POST', body: 'x' });
    ok(bad.status === 400, 'Từ chối file không phải video / ảnh');

    console.log('\nLời + AI');
    const sunoStyle = await api('POST', '/api/music/lyrics', { text: '[Intro - spoken, cheerful]\nTrời sáng rồi, dậy thôi nào!\n\n[Verse 1]\nMặt trời lên, chim hót rính rang,\nBé mở mắt, vươn vai thật to.\n\n[Chorus]\nĐánh răng nào!' });
    ok(sunoStyle.format === 'plain' && sunoStyle.lines.length === 4 && sunoStyle.lines[0].text === 'Trời sáng rồi, dậy thôi nào!' && 'clip' in sunoStyle.lines[0], 'Đọc lời có nhãn [Intro - …] / [Verse 1] / [Chorus]');
    const lyr = await api('POST', '/api/music/lyrics', { text: '[00:02.10]Con cò bé bé\n[00:05.00]Nó đậu cành tre\n[00:08.10]Đi không hỏi mẹ\n[00:12.00]Con cò bé bé\n[00:15.20]Biết đi đường nào' });
    await api('PUT', `/api/music/${p.id}`, { title: 'Con cò', lines: lyr.lines, options: { orientation: 'portrait', resolution: 480, fps: 24, maxShot: 3, fxAll: ['notes'], muteClips: false, clipVolume: 0.8 }, clipFx: { [files[0]]: ['bubbles'] } });
    for (const f of files) await api('POST', `/api/music/${p.id}/ai/describe`, { file: f });
    const again = await api('POST', `/api/music/${p.id}/ai/describe`, { file: files[0] });
    const calls1 = await (await fetch(aiBase + '/calls')).json();
    ok(again.cached && calls1.musicClip === 4, `AI xem mỗi clip 1 lần, lần sau lấy bộ nhớ (gọi ${calls1.musicClip} lần)`);
    p = await api('POST', `/api/music/${p.id}/ai/arrange`, {});
    ok(p.lines.every((l) => p.clips.includes(l.clip) && !('alts' in l)) && p.introClip === files[2], 'AI gán một clip cho từng câu, chọn clip nhạc dạo');
    ok(p.arrange?.unused?.[0] === files[3] && p.arrange.notes, 'Ghi lại clip không dùng + ghi chú của AI');
    ok(p.clipInfo[files[1]].desc && p.clipInfo[files[1]].energy >= 1, 'Lưu mô tả + mức sôi động của clip');

    console.log('\nAI chấm nhịp');
    const noKey = await fetch(`${BASE}/api/music/${p.id}/ai/align`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    ok(noKey.status === 400 && /Gemini/.test((await noKey.json()).error), 'Chưa có key Gemini -> báo cần Gemini (Claude không nghe được nhạc)');
    await api('PUT', '/api/settings', { geminiKey: 'gm-test-1', aiModelGemini: 'gemini-4-argon' });
    const clipsBefore = p.lines.map((l) => l.clip);
    p = await api('POST', `/api/music/${p.id}/ai/align`, {});
    const st = p.lines.map((l) => l.start);
    ok(st[0] === 2 && st[1] === 5 && st[2] === 8.5 && st[4] === 14, `Lấy thời gian từng câu (cả dạng m:ss, ghép theo số câu): ${st.join(', ')}`);
    ok(st[3] === null && p.align.dropped === 1 && p.align.timed === 4, 'Câu AI trả lùi thời gian -> bỏ trống, không làm loạn thứ tự');
    ok(p.lines[0].end === 4 && p.lines.map((l) => l.clip).join() === clipsBefore.join(), 'Có thời gian kết thúc; giữ nguyên clip đã xếp');

    console.log('\nAI tự chép lời');
    p = await api('POST', `/api/music/${p.id}/ai/transcribe`, {});
    const tx = p.lines.map((l) => l.text);
    ok(tx.length === 5 && tx[3] === 'Con cò bé bé' && !tx.includes('Câu trùng giờ'), `Chép lời: bỏ nhãn [Điệp khúc], bỏ câu trùng giờ (${tx.join(' / ')})`);
    ok(p.lines.map((l) => l.start).join() === '2,5,8.5,12,14', `Chấm lại thời gian lần 2; câu lần 2 bỏ trống lấy lại giờ lần 1 (${p.lines.map((l) => l.start).join(', ')})`);
    ok(p.lines.every((l) => p.clips.includes(l.clip)) && p.lyricsRaw.split('\n').length === 5 && p.title === 'Con cò' && p.align.transcribed, 'Tự gán clip cho câu mới, lưu lời, giữ tên video người dùng đặt');
    const c2 = await (await fetch(aiBase + '/calls')).json();
    ok(c2.musicTranscribe === 1 && c2.musicAlign === 2, 'Gọi AI 2 lần: chép lời + chấm lại thời gian');

    console.log('\nMốc các đoạn');
    const secs = await (async () => {
      process.env.GVA_DATA = data;
      return require('../lib/music').parseSections('[Intro]\n\n[Verse 1]\nCon cò bé bé\n[Chorus]\nĐi không hỏi mẹ\n(Verse 2)\nCon cò bé bé\nChorus:\nBiết đi đường nào\n[Bridge - soft]\nLa la\n[Outro]');
    })();
    ok(secs.map((x) => x.label).join() === 'Intro,Verse 1,Chorus 1,Verse 2,Chorus 2,Bridge,Outro' && secs[0].lines.length === 0, `Đọc nhãn đoạn, đánh số Chorus lặp (${secs.map((x) => x.label).join(', ')})`);
    p = await api('POST', `/api/music/${p.id}/ai/sections`, { data: { sectionLyrics: '[Intro]\n[Verse 1]\nCon cò bé bé\n[Chorus 1]\nĐi không hỏi mẹ\n[Verse 2]\nCon cò bé bé\n[Outro]' } });
    const si = p.sections.items;
    ok(si.map((x) => x.label).join() === 'Intro,Verse 1,Chorus 1,Verse 2,Outro' && si.map((x) => x.start).join() === '0,2,4.5,12,', `Mốc từng đoạn theo lời (cả dạng m:ss); đoạn AI trả lùi -> lấy giờ câu đầu trong bảng câu hát, không có thì để trống (${si.map((x) => x.start).join(', ')})`);
    ok(si[0].end === 2 && si[3].end === 20 && p.sections.dropped === 2 && !p.sections.auto, 'Đoạn kết thúc ở mốc đoạn kế tiếp; đếm mốc AI trả sai');
    p = await api('POST', `/api/music/${p.id}/ai/sections`, { data: { sectionLyrics: 'Con cò bé bé\nNó đậu cành tre' } });
    ok(p.sections.auto && p.sections.items.map((x) => `${x.label}@${x.start}`).join() === 'Intro@0,Verse 1@2.1,Final Chorus@12', `Lời không nhãn -> AI tự chia đoạn (${p.sections.items.map((x) => x.label).join(', ')})`);
    p = await api('PUT', `/api/music/${p.id}`, { sections: [{ label: 'Intro', start: 0 }, { label: 'Verse 1', start: 3 }] });
    ok(p.sections.items.length === 2 && p.sections.items[0].end === 3 && p.sectionLyrics.startsWith('Con cò'), 'Sửa tay mốc đoạn được lưu');
    await api('PUT', '/api/settings', { aiProvider: 'anthropic' });

    console.log('\nVideo intro (bắt buộc)');
    const noIntro = await fetch(`${BASE}/api/music/${p.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    ok(noIntro.status === 400 && /intro/i.test((await noIntro.json()).error), 'Chưa có intro -> không cho dựng');
    ok((await fetch(`${BASE}/api/music/intro?name=x.mp3`, { method: 'POST', body: 'x' })).status === 400, 'Intro không phải video -> từ chối');
    const introFile = path.join(tmp, 'intro.mp4');
    ff(['-f', 'lavfi', '-i', 'testsrc=s=1280x720:r=25:d=2', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-shortest', '-pix_fmt', 'yuv420p', introFile]);
    const it = (await api('POST', `/api/music/intro?name=${encodeURIComponent('Intro kênh.mp4')}`, null, fs.readFileSync(introFile))).intro;
    ok(it && Math.abs(it.dur - 2) < 0.1 && it.audio === true && it.name === 'Intro kênh.mp4', `Lưu video intro (${it?.dur}s, có tiếng)`);
    ok((await api('GET', '/api/music/intro')).intro?.file === it.file && (await fetch(BASE + it.url)).status === 200, 'Xem lại được video intro');

    console.log('\nVideo outro (bắt buộc)');
    const noOutro = await fetch(`${BASE}/api/music/${p.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    ok(noOutro.status === 400 && /outro/i.test((await noOutro.json()).error), 'Có intro nhưng chưa có outro -> không cho dựng');
    ok((await fetch(`${BASE}/api/music/outro?name=x.png`, { method: 'POST', body: 'x' })).status === 400, 'Outro không phải video -> từ chối');
    // outro 1.5s màu xanh dương, không tiếng
    const outroFile = path.join(tmp, 'outro.mp4');
    ff(['-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=25:d=1.5', '-pix_fmt', 'yuv420p', outroFile]);
    const ot = (await api('POST', `/api/music/outro?name=${encodeURIComponent('Outro kênh.mp4')}`, null, fs.readFileSync(outroFile))).outro;
    ok(ot && Math.abs(ot.dur - 1.5) < 0.1 && ot.audio === false && ot.name === 'Outro kênh.mp4', `Lưu video outro (${ot?.dur}s, không tiếng)`);
    ok((await api('GET', '/api/music/outro')).outro?.file === ot.file && (await fetch(BASE + ot.url)).status === 200 && (await api('GET', '/api/music/intro')).intro?.file === it.file, 'Xem lại được video outro, intro vẫn giữ nguyên');

    console.log('\nLogo kênh (bắt buộc)');
    const noLogo = await fetch(`${BASE}/api/music/${p.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    ok(noLogo.status === 400 && /logo/i.test((await noLogo.json()).error), 'Có intro + outro nhưng chưa có logo -> không cho dựng');
    // logo JPG nền trắng: khối đỏ 200x100 + bóng xám lệch xuống dưới -> chỉ giữ khối đỏ
    const logoJpg = path.join(tmp, 'logo.jpg');
    ff(['-f', 'lavfi', '-i', 'color=c=white:s=400x240', '-vf', 'drawbox=x=112:y=66:w=200:h=100:color=0xa8a8a8:t=fill,drawbox=x=100:y=50:w=200:h=100:color=red:t=fill', '-frames:v', '1', '-q:v', '2', logoJpg]);
    ok((await fetch(`${BASE}/api/music/logo?name=x.mp4`, { method: 'POST', body: 'x' })).status === 400, 'Logo không phải ảnh -> từ chối');
    let lg = (await api('POST', `/api/music/logo?name=${encodeURIComponent('Logo kênh.jpg')}`, null, fs.readFileSync(logoJpg))).logo;
    ok(lg && lg.removed && lg.position === 'tr' && lg.w >= 200 && lg.w <= 212 && lg.h >= 100 && lg.h <= 112, `Tự xoá nền + bóng, cắt sát logo (${lg?.w}x${lg?.h}), góc trên phải`);
    {
      const px = spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(data, 'music', 'logo', lg.file), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']).stdout;
      const at = (x, y) => [...px.subarray((y * lg.w + x) * 4, (y * lg.w + x) * 4 + 4)];
      const c = at(lg.w >> 1, lg.h >> 1);
      ok(at(0, 0)[3] === 0 && at(lg.w - 1, lg.h - 1)[3] === 0 && c[3] === 255 && c[0] > 200 && c[1] < 60, 'Nền trong suốt, logo giữ nguyên màu');
    }
    lg = (await api('PUT', '/api/music/logo', { size: 0.3, opacity: 2, position: 'xx' })).logo;
    ok(lg.size === 0.1 && lg.opacity === 1 && lg.position === 'tr', 'Cỡ logo cố định 10%, góc trên phải cố định');
    const lgOff = (await api('PUT', '/api/music/logo', { removeBg: false })).logo;
    ok(!lgOff.removed && lgOff.w >= 390, `Tắt xoá nền -> giữ cả ảnh (${lgOff.w}x${lgOff.h})`);
    lg = (await api('PUT', '/api/music/logo', { removeBg: true })).logo;
    ok(lg.removed && (await fetch(BASE + lg.url)).status === 200 && fs.readdirSync(path.join(data, 'music', 'logo')).length === 3, 'Bật lại xoá nền, file cũ được dọn');

    console.log('\nDựng');
    {
      const t = (await api('GET', `/api/music/${p.id}`)).title;
      await api('PUT', `/api/music/${p.id}`, { title: '  ' });
      ok((await fetch(`${BASE}/api/music/${p.id}/run`, { method: 'POST', body: '{}' })).status === 400, 'Chưa có tên video thì không cho dựng');
      await api('PUT', `/api/music/${p.id}`, { title: t });
    }
    {
      const noTitle = await fetch(`${BASE}/api/music/${p.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      ok(noTitle.status === 400 && /tên bài/i.test((await noTitle.json()).error), 'Chưa nhập tên bài lúc nhạc dạo -> không cho dựng');
    }
    await api('PUT', `/api/music/${p.id}`, { introTitle: '  Bài   Con Cò  ' });
    await api('PUT', `/api/music/${p.id}`, { name: 'Bé học hát' });
    ok(fs.existsSync(path.join(data, 'music', 'con-co-be-be')), 'Sửa tên dự án chưa đổi thư mục ngay');
    p = await api('POST', `/api/music/${p.id}/run`, {});
    ok(p.id === 'be-hoc-hat' && !fs.existsSync(path.join(data, 'music', 'con-co-be-be')), `Bấm dựng: thư mục đổi theo tên dự án (${p.id})`);
    for (let i = 0; i < 600; i++) {
      p = await api('GET', `/api/music/${p.id}`);
      if (!['queued', 'running'].includes(p.status)) break;
      await sleep(500);
    }
    ok(p.status === 'done', 'Dựng xong' + (p.error ? ': ' + p.error : ''));
    const out = path.join(data, 'music', p.id, 'Con cò.mp4');
    ok(p.videoFile === 'Con cò.mp4' && fs.existsSync(out) && !fs.existsSync(path.join(data, 'music', p.id, 'output.mp4')), `File video theo tên video (${p.videoFile})`);
    ok((await fetch(BASE + p.videoUrl)).status === 200, 'Tải được video theo tên mới');
    const pr = probe(out);
    const v = pr.streams.find((x) => x.codec_type === 'video');
    ok(v && v.width === 480 && v.height === 854 && pr.streams.some((x) => x.codec_type === 'audio'), `Khổ 9:16 480p có tiếng (${v?.width}x${v?.height})`);
    ok(Math.abs(Number(pr.format.duration) - 23.5) < 0.3, `Dài bằng intro + bài hát + outro (${Number(pr.format.duration).toFixed(2)}s)`);
    {
      // hình (không chỉ tiếng) cũng phải đủ intro + bài hát + outro: cảnh ảnh + cảnh video khác thông số màu từng làm mất hình
      const vd = Number(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=duration', '-of', 'csv=p=0', out]).stdout.toString());
      ok(Math.abs(vd - 23.5) < 0.1, `Hình đủ intro + bài hát + outro (${vd.toFixed(2)}s)`);
      // logo góc trên phải (480x854: rộng 0.1*480=48, lề 14): đỏ khi đang hát, không có trong intro
      const red = (t) => {
        const b = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1', '-vf', 'crop=20:10:432:20', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']).stdout;
        let n = 0;
        for (let i = 0; i < b.length; i += 3) if (b[i] > 180 && b[i + 1] < 80 && b[i + 2] < 80) n++;
        return n / (b.length / 3);
      };
      const rSong = red(12);
      const rIntro = red(1);
      const rOutro = red(23);
      ok(rSong > 0.9 && rIntro < 0.5 && rOutro < 0.5, `Logo ở góc trên phải lúc hát (đỏ ${Math.round(rSong * 100)}% lúc hát, ${Math.round(rIntro * 100)}% trong intro, ${Math.round(rOutro * 100)}% trong outro)`);
      // cuối video là outro: khung giữa màu xanh dương
      const mid = spawnSync('ffmpeg', ['-v', 'error', '-ss', '23', '-i', out, '-frames:v', '1', '-vf', 'crop=40:40:220:400', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']).stdout;
      let blue = 0;
      for (let i = 0; i < mid.length; i += 3) if (mid[i + 2] > 180 && mid[i] < 80 && mid[i + 1] < 80) blue++;
      ok(blue / (mid.length / 3) > 0.9, `Outro nằm ở cuối video (xanh ${Math.round((blue / (mid.length / 3)) * 100)}% ở giây 23)`);
      const srt = fs.readFileSync(path.join(data, 'music', p.id, 'lyrics.srt'), 'utf8');
      const firstCue = /(\d\d):(\d\d):(\d\d),(\d\d\d) -->/.exec(srt);
      const cueT = firstCue ? Number(firstCue[2]) * 60 + Number(firstCue[3]) + Number(firstCue[4]) / 1000 : 0;
      ok(cueT >= 2, `SRT dời sau intro (câu đầu ${cueT.toFixed(2)}s)`);
      ok(/Nối video intro "Intro kênh.mp4" \(2\.0s\)/.test(p.logs.map((l) => l.msg).join('\n')), 'Nhật ký: có nối intro');
      ok(/Nối video outro "Outro kênh.mp4" \(1\.5s\) vào cuối/.test(p.logs.map((l) => l.msg).join('\n')), 'Nhật ký: có nối outro');
      ok(/Hiện tên bài "Bài Con Cò" lúc nhạc dạo/.test(p.logs.map((l) => l.msg).join('\n')), 'Tên bài lúc nhạc dạo = tên đã nhập');
      ok(/Gắn logo "Logo kênh.jpg" ở góc trên phải/.test(p.logs.map((l) => l.msg).join('\n')), 'Nhật ký: có gắn logo');
    }
    const logs = p.logs.map((l) => l.msg).join('\n');
    ok(/120 BPM, cắt cảnh đúng phách/.test(logs) && /3 clip video/.test(logs), 'Nhật ký: nhịp + số clip');
    ok(/Giữ tiếng clip \(âm lượng 80%\)/.test(logs), 'Bật tiếng clip: trộn tiếng clip dưới bài hát');

    // điểm cắt cảnh rơi đúng phách (trừ cảnh đầu)
    process.env.GVA_DATA = data;
    const Music = require('../lib/music');
    const pj = JSON.parse(fs.readFileSync(path.join(data, 'music', p.id, 'project.json'), 'utf8'));
    const shots = Music.planShots(pj, Music.timeLines(pj.lines, 20), 20);
    const offBeat = shots.slice(1).filter((sh) => !pj.beats.beats.some((b) => Math.abs(b - sh.start) < 0.001));
    ok(shots.length >= 6 && !offBeat.length, `${shots.length} cảnh, mọi điểm cắt nằm đúng phách`);
    const allowed = new Set([pj.introClip, pj.outroClip, ...pj.lines.map((l) => l.clip)].filter(Boolean));
    ok(shots.every((sh) => allowed.has(sh.file)), 'Mỗi cảnh chỉ dùng clip của câu / nhạc dạo (không còn clip phụ)');
    ok(shots.some((sh) => sh.from > 0), 'Clip dùng lại chạy tiếp đoạn sau, không lặp đoạn đầu');

    console.log('\nXoá + bảo mật');
    p = await api('DELETE', `/api/music/${p.id}/clips/${files[1]}`);
    ok(!p.clips.includes(files[1]) && !p.lines.some((l) => l.clip === files[1]), 'Xoá clip: bỏ khỏi mọi câu');
    ok((await fetch(`${BASE}/mfiles/${p.id}/project.json`)).status === 404, 'Không đọc được file ngoài danh sách');
    ok((await fetch(`${BASE}/mfiles/${p.id}/clips/../project.json`)).status === 404, 'Chặn đường dẫn ../');
    const old2 = await api('GET', '/api/projects');
    const ml = await api('GET', '/api/music');
    ok(ml.some((x) => x.id === p.id && x.hasVideo && x.clips === 3 && x.lines === 5 && x.thumb), 'Danh sách video nhạc có đủ thông tin cho trang Dự án');
    ok(Array.isArray(old2) && old2.length === 0, 'API dự án video thường tách riêng (trang Dự án gộp ở giao diện)');
    const many = p.clips.slice(0, 2);
    p = await api('POST', `/api/music/${p.id}/clips/delete`, { files: [...many, 'khong_co.mp4'] });
    ok(p.clips.length === 1 && !many.some((f) => p.clips.includes(f) || p.lines.some((l) => l.clip === f) || p.introClip === f), 'Xoá nhiều clip một lần: bỏ khỏi mọi câu, bỏ qua tên lạ');
    ok(many.every((f) => !fs.existsSync(path.join(data, 'music', p.id, 'clips', f))), 'Xoá nhiều clip: file trên máy cũng bị xoá');
    ok(await api('POST', `/api/music/${p.id}/clips/delete`, { files: [] }).then(() => false, (e) => /400/.test(e.message)), 'Xoá nhiều mà không chọn clip nào -> 400');
  } catch (e) {
    console.error(e);
    failed++;
  } finally {
    cleanup();
  }
  console.log(failed ? `\n${failed} kiểm tra KHÔNG đạt` : '\nTất cả kiểm tra video nhạc đều đạt');
  process.exit(failed ? 1 : 0);
})();
