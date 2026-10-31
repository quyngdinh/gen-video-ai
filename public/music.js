(() => {
  'use strict';
  // Trang "Video nhạc": bài hát có sẵn + lời karaoke + các clip video ngắn -> video ca nhạc thiếu nhi.
  // Cảnh cắt đúng nhịp; AI xem clip rồi tự xếp clip theo lời bài hát.
  // Độc lập với trang "Tạo video" (API /api/music, dữ liệu data/music).

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(method, path, body, opts = {}) {
    const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: opts.signal });
    let j = null;
    try {
      j = await res.json();
    } catch (_) {}
    if (!res.ok) throw new Error((j && j.error) || 'Lỗi ' + res.status);
    return j;
  }
  /** Tải file lên (XHR để có % tiến độ — clip video có thể nặng). */
  function upload(path, file, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', path);
      x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      x.onload = () => {
        let j = null;
        try {
          j = JSON.parse(x.responseText);
        } catch (_) {}
        if (x.status >= 200 && x.status < 300) resolve(j);
        else reject(new Error((j && j.error) || 'Lỗi ' + x.status));
      };
      x.onerror = () => reject(new Error('Mất kết nối khi tải ' + file.name));
      x.send(file);
    });
  }
  /** opts: { ms — thời gian hiện, action: { label, fn } — nút bấm trong thông báo } */
  function toast(msg, type = '', opts = {}) {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    if (opts.action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn sm primary';
      b.textContent = opts.action.label;
      b.onclick = () => (el.remove(), opts.action.fn());
      el.append(document.createElement('br'), b);
    }
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), opts.ms || (type === 'err' ? 7000 : 3500));
  }

  // ---------- chữ AI hay chép sai: chỉ báo + để người dùng bấm sửa, không tự sửa ----------
  const LYRIC_FIXES = [{ from: 'Bôm', to: 'Bom' }];
  const FIX_MS = 10000; // thông báo trước / sau khi sửa hiện 10 giây
  const fixRe = (from) => new RegExp(`(?<!\\p{L})${from}(?!\\p{L})`, 'giu');
  const keepCase = (m, to) => (m === m.toUpperCase() ? to.toUpperCase() : m[0] === m[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1).toLowerCase() : to.toLowerCase());
  /** Các câu có chữ sai: [{ i, n, words: ['Bôm → Bom'] }] */
  function findLyricFixes() {
    const out = [];
    P.lines.forEach((l, i) => {
      const t = String(l.text || '').normalize('NFC');
      let n = 0;
      const words = [];
      for (const r of LYRIC_FIXES)
        for (const m of t.match(fixRe(r.from)) || []) {
          n++;
          words.push(`${m} → ${keepCase(m, r.to)}`);
        }
      if (n) out.push({ i, n, words });
    });
    return out;
  }
  const fixSummary = (found) => {
    const words = [...new Set(found.flatMap((f) => f.words))].join(', ');
    const rows = found.map((f) => f.i + 1);
    return `${words} (câu ${rows.slice(0, 12).join(', ')}${rows.length > 12 ? '…' : ''})`;
  };
  /** Báo trước (10 giây) có chữ sai, kèm nút "Sửa lời sai". */
  function warnLyricFixes() {
    const found = findLyricFixes();
    if (!found.length) return;
    const n = found.reduce((a, f) => a + f.n, 0);
    toast(`⚠ Phát hiện ${n} chữ AI có thể chép sai: ${fixSummary(found)}. Bấm “Sửa lời sai” để sửa.`, 'err', { ms: FIX_MS, action: { label: '✏️ Sửa lời sai', fn: fixLyrics } });
  }
  /** Người dùng bấm "Sửa lời sai": sửa rồi báo kết quả (10 giây). */
  function fixLyrics() {
    const found = findLyricFixes();
    if (!found.length) return toast('Không còn chữ nào cần sửa.', 'ok', { ms: FIX_MS });
    for (const f of found) {
      const l = P.lines[f.i];
      let t = String(l.text || '').normalize('NFC');
      for (const r of LYRIC_FIXES) t = t.replace(fixRe(r.from), (m) => keepCase(m, r.to));
      l.text = t;
    }
    P.lyricsRaw = P.lines.map((l) => l.text).join('\n');
    const n = found.reduce((a, f) => a + f.n, 0);
    drawLines();
    save();
    toast(`✅ Đã sửa ${n} chữ: ${fixSummary(found)}.`, 'ok', { ms: FIX_MS });
  }
  const fmtDur = (s) => {
    s = Math.round(s || 0);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  /** giây -> "m:ss.cc" */
  const fmtT = (t) => {
    if (t === null || t === undefined || !isFinite(t)) return '';
    const cs = Math.round(t * 100);
    return `${Math.floor(cs / 6000)}:${String(Math.floor((cs % 6000) / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
  };
  /** "m:ss.cc" | "ss.cc" -> giây (rỗng = null, sai dạng = undefined) */
  const parseT = (s) => {
    s = String(s || '').trim().replace(',', '.');
    if (!s) return null;
    const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(s);
    return m ? Number(m[1] || 0) * 60 + Number(m[2]) : undefined;
  };

  const STATUS = { idle: 'Chưa dựng', queued: 'Đang chờ', running: 'Đang dựng', done: 'Hoàn tất', error: 'Lỗi', canceled: 'Đã huỷ' };
  const CUR_KEY = 'gva.music.current';
  const fontList = (cur) => (meta.fonts.some((f) => f.name === cur) ? meta.fonts : [{ name: cur, label: cur, preset: 'classic' }, ...meta.fonts]);

  let meta = null; // { effects, presets }
  let P = null; // dự án nhạc đang mở (từ server)
  let naming = false; // đang hiện ô đặt tên dự án mới
  let newName = ''; // chữ đang gõ trong ô tên dự án mới (giữ lại khi trang vẽ lại)
  // gõ tiếng Việt (Telex/VNI) đang ghép dấu: Enter lúc này chỉ để chốt chữ, không phải lệnh
  const composing = (e) => e.isComposing || e.keyCode === 229;
  let sel = new Set(); // clip đang chọn để xoá nhiều
  let selFor = null; // id dự án của sel
  let pollT = null;
  let saveT = null;
  let writes = Promise.resolve(); // mọi lệnh ghi chạy lần lượt -> không ghi đè lẫn nhau
  let tap = null; // chế độ chấm nhịp: { ptr }
  let listen = null; // đang nghe thử một đoạn / câu: { key, end }
  let ai = null; // AI đang chạy: { ac, msg }
  let offset = 0.15; // bù thời gian phản xạ khi chấm nhịp (giây)
  try {
    offset = Number(localStorage.getItem('gva.music.offset') ?? 0.15) || 0;
  } catch (_) {}

  const active = () => location.hash.replace(/^#\//, '').split('?')[0] === 'music';
  const serial = (fn) => (writes = writes.then(fn, fn));
  const busy = () => ['queued', 'running'].includes(P?.status);

  // ---------- lưu ----------
  function payload() {
    return {
      name: P.name || '',
      title: P.title,
      lyricsRaw: P.lyricsRaw,
      sectionLyrics: P.sectionLyrics || '',
      sections: P.sections?.items,
      options: P.options,
      clips: P.clips,
      clipFx: P.clipFx,
      introClip: P.introClip,
      lines: P.lines.map((l) => ({ text: l.text, start: l.start, end: l.end, clip: l.clip, alts: l.alts || [] })),
    };
  }
  function save(now) {
    clearTimeout(saveT);
    const go = () =>
      serial(async () => {
        if (!P || busy()) return;
        try {
          const r = await api('PUT', `/api/music/${P.id}`, payload());
          P.updatedAt = r.updatedAt;
        } catch (e) {
          toast(e.message, 'err');
        }
      });
    if (now) return go();
    saveT = setTimeout(go, 500);
  }
  const remember = (id) => {
    try {
      localStorage.setItem(CUR_KEY, id);
    } catch (_) {}
  };

  async function openProject(id) {
    P = await api('GET', `/api/music/${id}`);
    naming = false;
    remember(P.id);
    draw();
  }
  /** "+ Video nhạc mới": hiện ô đặt tên dự án ở trên cùng; tên dự án = tên thư mục (con-co-be-be). */
  async function newProject() {
    if (P) await save(true);
    naming = true;
    newName = '';
    draw();
    $('#mNewName')?.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  async function createProject() {
    const name = $('#mNewName').value.trim();
    if (!name) {
      toast('Hãy đặt tên dự án.', 'err');
      return $('#mNewName').focus();
    }
    P = await api('POST', '/api/music', { name });
    naming = false;
    newName = '';
    remember(P.id);
    draw();
  }
  const slugify = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/gi, 'd')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'video-nhac';
  const fileName = (t) => String(t || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();

  // ---------- trang ----------
  async function render() {
    const app = $('#app');
    app.innerHTML = '<div class="empty">Đang tải…</div>';
    try {
      meta ??= await api('GET', '/api/music/meta');
      let id = null;
      try {
        id = localStorage.getItem(CUR_KEY);
      } catch (_) {}
      P = id ? await api('GET', `/api/music/${id}`).catch(() => null) : null;
      if (!P) {
        const list = await api('GET', '/api/music');
        P = list.length ? await api('GET', `/api/music/${list[0].id}`) : null;
        if (P) remember(P.id);
        else naming = true; // chưa có dự án nào: đặt tên dự án đầu tiên
      }
    } catch (e) {
      app.innerHTML = `<div class="err">${esc(e.message)}</div>`;
      return;
    }
    draw();
  }

  function seg(name, items, cur) {
    return `<div class="seg" data-seg="${name}">${items.map(([v, l, s]) => `<button type="button" data-v="${esc(v)}" class="${String(cur) === String(v) ? 'on' : ''}">${l}${s ? `<small>${s}</small>` : ''}</button>`).join('')}</div>`;
  }

  function drawDir() {
    const el = $('#mDir');
    if (!el) return;
    const want = P.name?.trim() ? slugify(P.name) : '';
    const same = want && (P.id === want || P.id.replace(/-\d+$/, '') === want);
    el.innerHTML = !want
      ? '<span style="color:var(--warn)">Nhập tên dự án — thư mục dự án sẽ đặt theo tên này khi bấm Dựng video nhạc.</span>'
      : same
        ? `Thư mục dự án: <code>data/music/${esc(P.id)}</code>`
        : `Thư mục hiện tại: <code>data/music/${esc(P.id)}</code> → khi bấm <b>Dựng video nhạc</b> sẽ đổi thành <code>${esc(want)}</code>`;
  }
  function newBox() {
    return `<section class="card" id="mNewBox"><h2>📁 Tên dự án mới <small style="color:var(--warn)">bắt buộc</small></h2>
        <p class="hint" style="margin-top:0">Thư mục dự án (chứa bài hát, clip, video đã dựng) sẽ đặt theo tên này, ví dụ: <b>Con cò bé bé</b> → <code>con-co-be-be</code>.</p>
        <div class="inline"><input type="text" id="mNewName" maxlength="120" placeholder="Ví dụ: Con cò bé bé" style="flex:1" value="${esc(newName)}"><button class="btn primary" id="mCreate" type="button">Tạo dự án</button>${P ? '<button class="btn ghost" id="mNewCancel" type="button">Huỷ</button>' : ''}</div>
        <p class="hint" id="mNewSlug"></p>
      </section>`;
  }
  function bindNew() {
    const inp = $('#mNewName');
    if (!inp) return;
    const show = () => ($('#mNewSlug').innerHTML = inp.value.trim() ? `Thư mục: <code>${esc(slugify(inp.value))}</code>` : '');
    show();
    inp.oninput = () => ((newName = inp.value), show());
    inp.onkeydown = (e) => e.key === 'Enter' && !composing(e) && createProject().catch((err) => toast(err.message, 'err'));
    $('#mCreate').onclick = () => createProject().catch((err) => toast(err.message, 'err'));
    if ($('#mNewCancel')) $('#mNewCancel').onclick = () => ((naming = false), (newName = ''), draw());
  }

  function draw() {
    if (!active()) return;
    const typing = document.activeElement?.id === 'mNewName';
    stopTap();
    if (!P) {
      $('#app').innerHTML = `<div class="page-head"><h1>🎵 Video nhạc thiếu nhi</h1></div>${newBox()}`;
      bindNew();
      return $('#mNewName').focus();
    }
    queueMicrotask(() => typing && $('#mNewName')?.focus());
    const o = P.options;
    const c = o.captions;
    const app = $('#app');
    app.innerHTML = `
      <div class="page-head"><h1>🎵 Video nhạc thiếu nhi</h1>
        <div class="inline"><select id="mList" title="Mở video nhạc khác"></select><button class="btn" id="mNew" type="button">+ Video nhạc mới</button></div></div>
${naming ? newBox() : ''}
      <section class="card"><div class="field" style="margin-top:0"><label>Tên dự án <small style="color:var(--warn)">bắt buộc</small></label>
        <input type="text" id="mName" maxlength="120" placeholder="Ví dụ: Con cò bé bé" value="${esc(P.name || '')}"></div>
        <p class="hint" id="mDir"></p></section>
      <p class="hint" style="margin:-8px 0 16px">Bài hát có sẵn + các <b>clip video ngắn</b> → video ca nhạc: AI tự nghe lời và chấm nhịp, lời karaoke, cảnh cắt đúng nhịp, AI chọn clip hợp từng câu hát. Mục này tách riêng, không ảnh hưởng mục <a href="#/create" style="color:var(--accent2)">Tạo video</a>.</p>

${BUMPERS.map(([k, n, where]) => `
      <section class="card"><h2><span class="num">${n}</span>Video ${k} <small style="color:var(--warn)">bắt buộc</small></h2>
        <p class="hint" style="margin-top:0">Dùng chung cho mọi video nhạc: tự nối vào ${where} video khi dựng (đưa về đúng khổ, độ phân giải, FPS của video).${k === 'intro' ? ' Lời karaoke và tên bài bắt đầu sau intro.' : ''}</p>
        <div class="drop" id="m${cap(k)}Drop"><b>Kéo thả video ${k} vào đây</b> hoặc bấm để chọn<br><small>mp4 · mov · webm · m4v (tối đa 600MB)</small></div>
        <input type="file" id="m${cap(k)}File" accept="video/*,.mp4,.mov,.m4v,.webm,.mkv" hidden>
        <div id="m${cap(k)}Box"></div>
      </section>
`).join('')}
      <section class="card"><h2><span class="num">3</span>Logo kênh <small style="color:var(--warn)">bắt buộc</small></h2>
        <p class="hint" style="margin-top:0">Dùng chung cho mọi video nhạc: hiện ở góc video trong phần bài hát (không có trong intro / outro). Ảnh nền trắng / nền trơn (JPG) được tự xoá nền, chỉ giữ phần logo — không che hình video.</p>
        <div class="drop" id="mLogoDrop"><b>Kéo thả ảnh logo vào đây</b> hoặc bấm để chọn<br><small>png · jpg · webp (PNG nền trong suốt được giữ nguyên)</small></div>
        <input type="file" id="mLogoFile" accept="image/*,.png,.jpg,.jpeg,.webp" hidden>
        <div id="mLogoBox"></div>
      </section>

      <section class="card"><h2><span class="num">4</span>Khổ video</h2>
        <div class="field" style="margin-top:0"><label>Tên video <small style="color:var(--warn)">bắt buộc</small></label><input type="text" id="mTitle" maxlength="120" placeholder="Ví dụ: Con cò bé bé" value="${esc(P.title)}"><p class="hint" id="mTitleFile"></p></div>
        <div class="choice-row" style="margin-top:14px">
          <button type="button" class="choice ${o.orientation === 'landscape' ? 'on' : ''}" data-ori="landscape"><span class="shape land"></span><b>Long form 16:9</b><small>YouTube, TV</small></button>
          <button type="button" class="choice ${o.orientation === 'portrait' ? 'on' : ''}" data-ori="portrait"><span class="shape port"></span><b>Short form 9:16</b><small>Shorts, TikTok, Reels</small></button>
        </div>
        <div class="row"><div class="field"><label>Độ phân giải</label>${seg('resolution', [[720, '720p'], [1080, '1080p', 'khuyên dùng'], [1440, '1440p']], o.resolution)}</div>
        <div class="field"><label>FPS</label>${seg('fps', [[24, '24'], [30, '30'], [60, '60']], o.fps)}</div></div>
      </section>

      <section class="card"><h2><span class="num">5</span>Bài hát</h2>
        <div class="drop" id="mSongDrop"><b>Kéo thả file nhạc vào đây</b> hoặc bấm để chọn<br><small>mp3 · m4a · wav · aac · ogg · flac (tối đa 80MB). Bài hát đã có giọng hát — tải lên xong, AI tự nghe để chép lời và chấm nhịp từng câu.</small></div>
        <input type="file" id="mSongFile" accept="audio/*,.mp3,.m4a,.wav,.aac,.ogg,.flac" hidden>
        <div id="mSongBox"></div>
        <div class="field"><label>Lời bài hát có nhãn đoạn <small>(để tìm mốc Intro, Verse, Chorus…)</small></label>
          <textarea id="mSecLyrics" rows="7" placeholder="[Intro]&#10;&#10;[Verse 1]&#10;Một con vịt xoè ra hai cái cánh…&#10;&#10;[Chorus 1]&#10;…&#10;&#10;Không có nhãn đoạn thì AI tự chia bài theo cấu trúc chuẩn.">${esc(P.sectionLyrics || '')}</textarea></div>
        <div id="mSections"></div>
        <label class="check" style="margin-top:12px"><input type="checkbox" id="mNorm" ${o.normalizeAudio ? 'checked' : ''}> Chuẩn hoá âm lượng (−14 LUFS, chuẩn YouTube)</label>
      </section>

      <section class="card"><h2><span class="num">6</span>Clip video &amp; hiệu ứng</h2>
        <div class="drop" id="mClipDrop"><b>Kéo thả các clip video ngắn vào đây</b> hoặc bấm để chọn<br><small>mp4 · mov · webm · m4v (tối đa 600MB / clip). Ảnh tĩnh cũng dùng được.</small></div>
        <input type="file" id="mClipFile" accept="video/*,image/*,.mp4,.mov,.m4v,.webm,.mkv" multiple hidden>
        <div id="mUploads"></div>
        <div class="maudio">
          <label class="check"><span class="switch"><input type="checkbox" id="mMute" ${o.muteClips ? 'checked' : ''}><span></span></span> 🔇 Tắt âm thanh tất cả clip <small id="mAudCount"></small></label>
          <div class="rng" id="mClipVolBox" ${o.muteClips ? 'hidden' : ''}><span class="lbl">Âm lượng tiếng clip</span><input type="range" id="mClipVol" min="0" max="1.5" step="0.05" value="${o.clipVolume}"><output>${Math.round(o.clipVolume * 100)}%</output></div>
        </div>
        <div class="fxbar" id="mClipSel" hidden></div>
        <div class="thumbs mclips" id="mThumbs"></div>
        <p class="hint">Rê chuột lên clip để xem. Bấm biểu tượng dưới clip để bật / tắt hiệu ứng cho các cảnh dùng clip đó.</p>
        <div class="field"><label>Hiệu ứng cho toàn bộ video</label><div class="fxchips" id="mFxAll"></div></div>
        <div class="field"><label>Mật độ hiệu ứng</label><div class="rng"><input type="range" id="mDensity" min="0.3" max="2.5" step="0.1" value="${o.fxDensity}"><output>${o.fxDensity}×</output></div></div>
      </section>

      <section class="card"><h2><span class="num">7</span>Lời &amp; clip theo nhạc</h2>
        <div id="mArrange"></div>
        <div id="mLinesTools"></div>
        <div id="mTap"></div>
        <div class="mrows" id="mRows"></div>
      </section>

      <section class="card"><h2><span class="num">8</span>Hình &amp; chữ</h2>
        <div class="row"><div class="field"><label>Cách đặt clip vào khung</label>${seg('fit', [['cover', 'Phủ kín', 'cắt viền'], ['blur', 'Trọn clip', 'nền mờ'], ['color', 'Trọn clip', 'nền màu']], o.fit)}</div>
          <div class="field" id="mBgField" ${o.fit === 'color' ? '' : 'hidden'}><label>Màu nền</label><input type="color" id="mBg" value="${esc(o.bgColor)}"></div></div>
        <div class="row"><div class="field"><label>Cắt cảnh</label><label class="check"><input type="checkbox" id="mBeat" ${o.cutOnBeat ? 'checked' : ''}> Cắt đúng nhịp bài hát${P.beats?.bpm ? ` <small>(~${Math.round(P.beats.bpm)} BPM)</small>` : ''}</label></div>
          <div class="field"><label>Chuyển cảnh</label>${seg('transition', [['none', 'Cắt thẳng'], ['fade', 'Mờ dần']], o.transition)}</div></div>
        <div class="field"><label>Mỗi cảnh dài tối đa (câu dài hơn thì chuyển sang clip phụ)</label><div class="rng"><input type="range" id="mMaxShot" min="1.5" max="20" step="0.5" value="${o.maxShot}"><output>${o.maxShot}s</output></div></div>
        <div class="row" style="margin-top:18px">
          <label class="check"><span class="switch"><input type="checkbox" id="mCapOn" ${c.on ? 'checked' : ''}><span></span></span> Hiện lời bài hát</label>
          <label class="check"><span class="switch"><input type="checkbox" id="mKara" ${c.karaoke ? 'checked' : ''}><span></span></span> Karaoke (tô màu chữ theo giọng hát)</label>
          <label class="check"><input type="checkbox" id="mIntro" ${o.titleIntro ? 'checked' : ''}> Hiện tên bài lúc nhạc dạo</label>
        </div>
        <div id="mCapOpts" class="${c.on ? '' : 'dim'}">
          <div class="field"><label>Màu chữ</label><div class="seg" id="mPresets">${Object.entries(meta.presets).map(([k, v]) => `<button type="button" data-v="${k}" class="${c.preset === k ? 'on' : ''}"><span class="swatch" style="--s:#${v.sung};--u:#${v.unsung};--o:#${v.outline}"><b>Aa</b><b>Aa</b></span>${esc(v.label)}</button>`).join('')}</div></div>
          <div class="field"><label>Font <small>(chọn font sẽ đổi màu chữ theo font)</small></label><div class="mfonts" id="mFonts">${fontList(c.font).map((f) => {
            const v = meta.presets[f.preset] || meta.presets.candy;
            return `<button type="button" data-v="${esc(f.name)}" class="${c.font === f.name ? 'on' : ''}" title="${esc(f.name)}"><b style="font-family:'${esc(f.name)}';--s:#${v.sung};--o:#${v.outline}">Bé vui hát</b><small>${esc(f.label)}</small></button>`;
          }).join('')}</div></div>
          <div class="field"><label>Vị trí</label>${seg('position', [['bottom', 'Dưới'], ['middle', 'Giữa'], ['top', 'Trên']], c.position)}</div>
          <div class="field"><label>Cỡ chữ</label><div class="rng"><input type="range" id="mSize" min="0.6" max="2" step="0.05" value="${c.sizeMul}"><output>${Math.round(c.sizeMul * 100)}%</output></div></div>
          <label class="check" style="margin-top:10px"><input type="checkbox" id="mUpper" ${c.uppercase ? 'checked' : ''}> VIẾT HOA</label>
        </div>
      </section>

      <section class="card" id="mResult"></section>

      <div class="actionbar"><div class="in">
        <div class="sum" id="mSum"></div>
        <button class="btn primary" id="mRun" type="button">🎬 Dựng video nhạc</button>
      </div></div>`;

    bind();
    bindNew();
    drawList();
    for (const [k] of BUMPERS) drawBumper(k, true);
    drawLogo(true);
    drawSong();
    drawSections();
    drawThumbs();
    drawFxAll();
    drawLines();
    drawResult();
    drawSum();
    if (busy()) startPoll();
  }

  async function drawList() {
    const sel = $('#mList');
    if (!sel) return;
    const list = await api('GET', '/api/music').catch(() => []);
    if (!$('#mList')) return;
    sel.innerHTML = list.map((x) => `<option value="${x.id}" ${x.id === P.id ? 'selected' : ''}>${esc(x.title)}${x.hasVideo ? ' ✓' : ''}</option>`).join('') + (list.length ? '<option value="__del">🗑 Xoá video nhạc đang mở…</option>' : '');
  }

  function bind() {
    $('#mNew').onclick = () => newProject().catch((e) => toast(e.message, 'err'));
    $('#mList').onchange = async (e) => {
      const v = e.target.value;
      if (v === '__del') {
        if (!confirm('Xoá video nhạc này cùng toàn bộ file (bài hát, clip, video)?')) return (e.target.value = P.id);
        try {
          await api('DELETE', `/api/music/${P.id}`);
          localStorage.removeItem(CUR_KEY);
        } catch (err) {
          toast(err.message, 'err');
        }
        return render();
      }
      await save(true);
      openProject(v).catch((err) => toast(err.message, 'err'));
    };
    const titleFile = () => {
      const n = fileName(P.title);
      $('#mTitleFile').innerHTML = n ? `File video xuất ra: <code>${esc(n)}.mp4</code>` : '<span style="color:var(--warn)">Nhập tên video để xuất ra file video đúng tên.</span>';
    };
    titleFile();
    $('#mTitle').oninput = (e) => ((P.title = e.target.value), titleFile(), save());
    // chỉ lưu tên; thư mục được đổi theo tên dự án khi bấm "Dựng video nhạc"
    drawDir();
    $('#mName').oninput = (e) => ((P.name = e.target.value), drawDir(), save());
    $('#mSecLyrics').oninput = (e) => ((P.sectionLyrics = e.target.value), save());
    $$('[data-ori]').forEach((b) =>
      b.addEventListener('click', () => {
        P.options.orientation = b.dataset.ori;
        $$('[data-ori]').forEach((x) => x.classList.toggle('on', x === b));
        save();
        drawLogo();
        drawSum();
      }),
    );
    $$('[data-seg]').forEach((g) =>
      g.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const k = g.dataset.seg;
        const v = ['resolution', 'fps'].includes(k) ? Number(b.dataset.v) : b.dataset.v;
        if (k === 'position') P.options.captions.position = v;
        else P.options[k] = v;
        $$('button', g).forEach((x) => x.classList.toggle('on', x === b));
        if (k === 'fit') $('#mBgField').hidden = v !== 'color';
        save();
        drawSum();
      }),
    );
    $('#mPresets').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      P.options.captions.preset = b.dataset.v;
      $$('#mPresets button').forEach((x) => x.classList.toggle('on', x === b));
      save();
    });
    $('#mBg').oninput = (e) => ((P.options.bgColor = e.target.value), save());
    $('#mNorm').onchange = (e) => ((P.options.normalizeAudio = e.target.checked), save());
    $('#mIntro').onchange = (e) => ((P.options.titleIntro = e.target.checked), save());
    $('#mBeat').onchange = (e) => ((P.options.cutOnBeat = e.target.checked), save());
    $('#mMute').onchange = (e) => {
      P.options.muteClips = e.target.checked;
      $('#mClipVolBox').hidden = e.target.checked;
      drawThumbs();
      save();
    };
    $('#mCapOn').onchange = (e) => {
      P.options.captions.on = e.target.checked;
      $('#mCapOpts').classList.toggle('dim', !e.target.checked);
      save();
    };
    $('#mKara').onchange = (e) => ((P.options.captions.karaoke = e.target.checked), save());
    $('#mUpper').onchange = (e) => ((P.options.captions.uppercase = e.target.checked), save());
    $('#mFonts').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const f = meta.fonts.find((x) => x.name === b.dataset.v);
      P.options.captions.font = b.dataset.v;
      $$('#mFonts button').forEach((x) => x.classList.toggle('on', x === b));
      // màu chữ đi theo font vừa chọn (vẫn đổi lại được ở "Màu chữ")
      if (f && meta.presets[f.preset]) {
        P.options.captions.preset = f.preset;
        $$('#mPresets button').forEach((x) => x.classList.toggle('on', x.dataset.v === f.preset));
      }
      save();
    });
    const range = (id, set, fmt) => {
      const el = $(id);
      el.oninput = () => {
        set(Number(el.value));
        el.nextElementSibling.textContent = fmt(Number(el.value));
        save();
      };
    };
    range('#mSize', (v) => (P.options.captions.sizeMul = v), (v) => Math.round(v * 100) + '%');
    range('#mMaxShot', (v) => (P.options.maxShot = v), (v) => v + 's');
    range('#mClipVol', (v) => (P.options.clipVolume = v), (v) => Math.round(v * 100) + '%');
    range('#mDensity', (v) => (P.options.fxDensity = v), (v) => v + '×');

    // video intro / outro
    for (const [k] of BUMPERS) {
      const inp = $(`#m${cap(k)}File`);
      $(`#m${cap(k)}Drop`).onclick = () => inp.click();
      inp.onchange = () => {
        inp.files[0] && uploadBumper(k, inp.files[0]);
        inp.value = '';
      };
      dropZone($(`#m${cap(k)}Drop`), (files) => files[0] && uploadBumper(k, files[0]));
    }

    // logo kênh
    const logoIn = $('#mLogoFile');
    $('#mLogoDrop').onclick = () => logoIn.click();
    logoIn.onchange = () => {
      logoIn.files[0] && uploadLogo(logoIn.files[0]);
      logoIn.value = '';
    };
    dropZone($('#mLogoDrop'), (files) => files[0] && uploadLogo(files[0]));

    // bài hát
    const songIn = $('#mSongFile');
    $('#mSongDrop').onclick = () => songIn.click();
    songIn.onchange = () => songIn.files[0] && uploadSong(songIn.files[0]);
    dropZone($('#mSongDrop'), (files) => files[0] && uploadSong(files[0]));

    // clip
    const clipIn = $('#mClipFile');
    $('#mClipDrop').onclick = () => clipIn.click();
    clipIn.onchange = () => {
      uploadClips([...clipIn.files]);
      clipIn.value = '';
    };
    dropZone($('#mClipDrop'), uploadClips);

    $('#mRun').onclick = run;
  }

  function dropZone(el, onFiles) {
    el.addEventListener('dragover', (e) => (e.preventDefault(), el.classList.add('over')));
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('over');
      onFiles([...e.dataTransfer.files]);
    });
  }

  // ---------- video intro / outro (dùng chung, bắt buộc) ----------
  const BUMPERS = [
    ['intro', 1, 'đầu'],
    ['outro', 2, 'cuối'],
  ];
  const cap = (k) => k[0].toUpperCase() + k.slice(1);
  const bump = { intro: undefined, outro: undefined }; // undefined = chưa tải thông tin, null = chưa có
  async function drawBumper(k, fetchIt) {
    if (fetchIt)
      try {
        bump[k] = (await api('GET', `/api/music/${k}`))[k];
      } catch (_) {}
    const box = $(`#m${cap(k)}Box`);
    if (!box) return;
    const b = bump[k];
    box.innerHTML = b
      ? `<div class="box" style="margin-top:12px"><div class="inline" style="justify-content:space-between"><b>🎬 ${esc(b.name)}</b><span class="inline"><small>${fmtDur(b.dur)} · ${b.w}×${b.h}${b.audio ? ' · có tiếng' : ' · không tiếng'}</small><button class="btn sm danger" data-del type="button">Xoá</button></span></div><video controls preload="metadata" src="${esc(b.url)}" style="margin-top:8px;max-height:240px"></video></div>`
      : b === null
        ? `<p class="hint" style="color:var(--warn)">Chưa có video ${k} — cần tải lên trước khi dựng video.</p>`
        : '';
    const del = $('[data-del]', box);
    if (del)
      del.onclick = async () => {
        if (!confirm(`Xoá video ${k}? Video nhạc sẽ không dựng được cho đến khi tải ${k} mới.`)) return;
        try {
          bump[k] = (await api('DELETE', `/api/music/${k}`))[k];
        } catch (e) {
          toast(e.message, 'err');
        }
        drawBumper(k);
      };
    drawSum();
  }
  async function uploadBumper(k, file) {
    const box = $(`#m${cap(k)}Box`);
    box.innerHTML = `<p class="hint">Đang tải ${esc(file.name)}…</p>`;
    try {
      const r = await upload(`/api/music/${k}?name=${encodeURIComponent(file.name)}`, file, (f) => box.isConnected && (box.innerHTML = `<p class="hint">Đang tải ${esc(file.name)}… ${Math.round(f * 100)}%</p>`));
      bump[k] = r[k];
      toast(`Đã lưu video ${k}`, 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
    drawBumper(k);
  }

  // ---------- logo kênh (dùng chung, bắt buộc) ----------
  let logo; // undefined = chưa tải thông tin, null = chưa có logo
  let logoT = null;
  let logoPend = {};
  async function drawLogo(fetchIt) {
    if (fetchIt) {
      try {
        logo = (await api('GET', '/api/music/logo')).logo;
      } catch (_) {}
    }
    const box = $('#mLogoBox');
    if (!box) return;
    if (!logo) {
      box.innerHTML = logo === null ? '<p class="hint" style="color:var(--warn)">Chưa có logo kênh — cần tải lên trước khi dựng video.</p>' : '';
      return drawSum();
    }
    const land = P.options.orientation !== 'portrait';
    box.innerHTML = `<div class="box" style="margin-top:12px">
        <div class="inline" style="justify-content:space-between"><b>🏷 ${esc(logo.name)}</b><span class="inline"><small>${logo.w}×${logo.h}${logo.removed ? ' · đã xoá nền' : ''}</small><button class="btn sm danger" id="mLogoDel" type="button">Xoá</button></span></div>
        <div class="mlogo-row">
          <div class="mlogo-chk"><img src="${esc(logo.url)}" alt="Logo sau khi xử lý"></div>
          <div class="mlogo-frame ${land ? '' : 'port'}" title="Vị trí logo trên video (minh hoạ)"><img class="pos-${logo.position}" src="${esc(logo.url)}" style="width:${(logo.size * 100).toFixed(1)}%;opacity:${logo.opacity}" alt=""></div>
        </div>
        <label class="check" style="margin-top:10px"><input type="checkbox" id="mLogoBg" ${logo.removeBg ? 'checked' : ''}> Tự xoá nền ảnh (nền trắng / nền trơn)</label>
        <div class="row"><div class="field"><label>Cỡ logo</label><p class="hint" style="margin:6px 0 0">Cố định ${Math.round(logo.size * 100)}% bề ngang video, góc trên phải</p></div>
          <div class="field"><label>Độ đậm</label><div class="rng"><input type="range" id="mLogoOp" min="0.1" max="1" step="0.05" value="${logo.opacity}"><output>${Math.round(logo.opacity * 100)}%</output></div></div></div>
      </div>`;
    const put = (data, now) => {
      Object.assign(logo, data);
      logoPend = { ...logoPend, ...data }; // gộp các thay đổi đang chờ lưu
      clearTimeout(logoT);
      const go = async () => {
        const body = logoPend;
        logoPend = {};
        try {
          logo = (await api('PUT', '/api/music/logo', body)).logo;
        } catch (e) {
          toast(e.message, 'err');
        }
        if (now) drawLogo();
      };
      if (now) return go();
      logoT = setTimeout(go, 400);
    };
    const frameImg = $('.mlogo-frame img', box);
    $('#mLogoOp').oninput = (e) => {
      const v = Number(e.target.value);
      e.target.nextElementSibling.textContent = Math.round(v * 100) + '%';
      frameImg.style.opacity = v;
      put({ opacity: v });
    };
    $('#mLogoBg').onchange = (e) => {
      $('#mLogoBox .mlogo-row').style.opacity = 0.4;
      put({ removeBg: e.target.checked }, true);
    };
    $('#mLogoDel').onclick = async () => {
      if (!confirm('Xoá logo? Cần tải logo mới thì mới dựng được video nhạc.')) return;
      try {
        logo = (await api('DELETE', '/api/music/logo')).logo;
      } catch (e) {
        toast(e.message, 'err');
      }
      drawLogo();
    };
    drawSum();
  }
  async function uploadLogo(file) {
    const box = $('#mLogoBox');
    box.innerHTML = `<p class="hint">Đang tải và xoá nền ${esc(file.name)}…</p>`;
    try {
      logo = (await upload(`/api/music/logo?name=${encodeURIComponent(file.name)}`, file)).logo;
      toast(logo.removed ? 'Đã lưu logo (đã tự xoá nền)' : 'Đã lưu logo', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
    drawLogo();
  }

  // ---------- bài hát ----------
  function uploadSong(file) {
    let ok = false;
    const box = $('#mSongBox');
    box.innerHTML = `<p class="hint">Đang tải ${esc(file.name)}…</p>`;
    return serial(async () => {
      try {
        const r = await upload(`/api/music/${P.id}/assets?kind=song&name=${encodeURIComponent(file.name)}`, file, (f) => box.isConnected && (box.innerHTML = `<p class="hint">Đang tải ${esc(file.name)}… ${Math.round(f * 100)}% (xong sẽ dò nhịp bài hát)</p>`));
        Object.assign(P, { song: r.project.song, songName: r.project.songName, songDuration: r.project.songDuration, songUrl: r.project.songUrl, beats: r.project.beats, sections: r.project.sections });
        if (!P.title && r.project.title) {
          P.title = r.project.title;
          $('#mTitle').value = P.title;
        }
        toast(`Đã tải bài hát${P.beats?.bpm ? ` — nhịp ~${Math.round(P.beats.bpm)} BPM` : ''}`, 'ok');
        ok = true;
      } catch (e) {
        toast(e.message, 'err');
      }
      drawSong();
      drawSections();
      drawSum();
    }).then(() => {
      // bài mới -> lời cũ không còn khớp: AI nghe lại (hỏi trước nếu đã có lời)
      if (ok && (!P.lines.length || confirm('Đã đổi bài hát. Cho AI nghe bài mới để chép lại lời + chấm nhịp?'))) aiTranscribe(true);
    });
  }
  function drawSong() {
    const box = $('#mSongBox');
    if (!box) return;
    box.innerHTML = P.songUrl
      ? `<div class="box" style="margin-top:12px"><div class="inline" style="justify-content:space-between"><b>🎵 ${esc(P.songName)}</b><small>${fmtDur(P.songDuration)}${P.beats?.bpm ? ` · ~${Math.round(P.beats.bpm)} BPM` : ''}</small></div><audio id="mAudio" controls preload="auto" src="${esc(P.songUrl)}" style="margin-top:8px"></audio></div>`
      : '';
    const au = $('#mAudio');
    if (!au) return;
    au.addEventListener('timeupdate', () => {
      // nghe thử một đoạn / một câu: hết đoạn thì tự dừng
      if (listen?.end && au.currentTime >= listen.end) au.pause();
      markPlaying();
    });
    au.addEventListener('play', playIcons);
    au.addEventListener('pause', () => {
      listen = null;
      playIcons();
    });
  }

  // ---------- mốc các đoạn bài hát (Intro, Verse 1, Chorus 1…) ----------
  async function aiSections() {
    if (ai) {
      if (ai.kind === 'sections') ai.ac.abort();
      return;
    }
    if (!P.songUrl) return toast('Hãy tải bài hát trước.', 'err');
    if (P.sections?.items?.length && !confirm('AI sẽ tìm lại mốc tất cả các đoạn (mốc đã sửa tay sẽ mất). Tiếp tục?')) return;
    const labeled = /^\s*(\[[^\]]+\]|\((intro|verse|chorus|bridge|outro)[^)]*\))\s*$/im.test(P.sectionLyrics || '');
    ai = { kind: 'sections', ac: new AbortController(), msg: `🎧 AI đang nghe bài hát (${fmtDur(P.songDuration)}) để ${labeled ? 'tìm mốc từng đoạn theo lời' : 'tự chia đoạn'}… thường mất 20–60 giây` };
    drawSections();
    drawLines();
    try {
      clearTimeout(saveT);
      await save(true);
      const r = await serial(() => api('POST', `/api/music/${P.id}/ai/sections`, { data: payload() }, { signal: ai.ac.signal }));
      Object.assign(P, { sections: r.sections, updatedAt: r.updatedAt });
      const it = r.sections.items;
      const n = it.filter((x) => x.start !== null).length;
      toast(`Đã tìm mốc ${n}/${it.length} đoạn${n < it.length ? ' — đoạn trống có thể gõ tay' : ''}. Bấm ▶ để nghe kiểm tra.`, n ? 'ok' : 'err');
    } catch (e) {
      if (ai.ac.signal.aborted) toast('Đã dừng AI');
      else toast(e.message, 'err');
    }
    ai = null;
    drawSections();
    drawLines();
  }

  const PRINT_FMTS = [
    ['yt', 'YouTube', '0:00 Intro'],
    ['range', 'Bắt đầu – kết thúc', 'Intro: 0:00.00 – 0:14.94 (14.9s)'],
    ['first', 'Kèm câu đầu', '0:00.00 Intro — câu hát đầu'],
  ];
  let printFmt = 'yt';
  try {
    printFmt = localStorage.getItem('gva.music.secfmt') || 'yt';
  } catch (_) {}
  /** Mốc các đoạn dạng chữ để chép. YouTube: "0:00 Intro" mỗi dòng, chương đầu phải là 0:00. */
  function printSections() {
    const it = (P.sections?.items || []).filter((s) => s.start !== null);
    return it
      .map((s, i) => {
        if (printFmt === 'range') return `${s.label}: ${fmtT(s.start)} – ${fmtT(s.end)}${s.end > s.start ? ` (${(s.end - s.start).toFixed(1)}s)` : ''}`;
        if (printFmt === 'first') return `${fmtT(s.start)} ${s.label}${s.first ? ' — ' + s.first : ''}`;
        return `${fmtDur(i ? Math.floor(s.start) : 0)} ${s.label}`;
      })
      .join('\n');
  }

  function drawSections() {
    const box = $('#mSections');
    if (!box) return;
    const S = P.sections;
    const it = S?.items || [];
    const busyMe = ai?.kind === 'sections';
    box.innerHTML = `<div class="mtools">
        <button class="btn ${it.length ? '' : 'primary'}" id="mSecBtn" type="button" ${P.songUrl && (!ai || busyMe) ? '' : 'disabled'}>${busyMe ? '⏹ Dừng AI' : it.length ? '🧭 Tìm lại mốc các đoạn' : '🧭 Tìm mốc các đoạn'}</button>
        <span class="hint" style="margin:0">${busyMe ? esc(ai.msg) : P.songUrl ? 'AI (Gemini) nghe bài hát, đối chiếu với lời để tìm lúc bắt đầu từng đoạn.' : 'Tải bài hát trước.'}</span>
        ${it.length && !busyMe ? '<span class="sp1"></span><button class="btn sm" id="mSecCopy" type="button" title="Chép đúng nội dung ô Mốc các đoạn bên dưới">📋 Chép mốc</button>' : ''}
      </div>
      ${it.length ? `<div class="msecs">${it.map((s, i) => `<div class="msec" data-i="${i}">
          <button class="ib mplay" type="button" data-play="s${i}" ${s.start === null ? 'disabled' : ''}>▶</button>
          <b class="mlabel">${esc(s.label)}</b>
          <input class="mt" type="text" value="${fmtT(s.start)}" placeholder="--:--" title="Bắt đầu (phút:giây) — sửa được">
          <span class="mlen">${s.start !== null && s.end !== null && s.end > s.start ? `${(s.end - s.start).toFixed(1)}s` : ''}</span>
          <span class="mfirst" title="${esc(s.first)}">${s.first ? esc(s.first) : '<i>chỉ có nhạc</i>'}</span>
        </div>`).join('')}</div>
        <div class="mprint"><div class="inline" style="justify-content:space-between;flex-wrap:wrap;gap:8px"><b>📄 Mốc các đoạn</b>${seg('secfmt', PRINT_FMTS, printFmt)}</div>
          <textarea id="mSecText" readonly rows="${Math.max(3, it.filter((s) => s.start !== null).length)}" title="Bấm để chọn hết"></textarea></div>
        ${S.notes || S.auto ? `<p class="hint">${S.auto ? 'Lời không có nhãn đoạn → AI tự chia đoạn. ' : ''}${S.notes ? '🤖 ' + esc(S.notes) : ''}</p>` : ''}` : ''}`;
    $('#mSecBtn').onclick = aiSections;
    const txt = $('#mSecText');
    if (txt) {
      txt.value = printSections();
      txt.onclick = () => txt.select();
      $('[data-seg="secfmt"]', box).onclick = (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        printFmt = b.dataset.v;
        try {
          localStorage.setItem('gva.music.secfmt', printFmt);
        } catch (_) {}
        drawSections();
      };
    }
    if ($('#mSecCopy'))
      $('#mSecCopy').onclick = () =>
        navigator.clipboard.writeText(printSections()).then(
          () => toast('Đã chép mốc các đoạn', 'ok'),
          () => toast('Không chép được — hãy chọn và chép tay', 'err'),
        );
    $$('.msec', box).forEach((r) => {
      const s = it[Number(r.dataset.i)];
      $('.mplay', r).onclick = () => playFrom(s.start, 's' + r.dataset.i, s.end);
      $('.mt', r).onchange = (e) => {
        const t = parseT(e.target.value);
        if (t === undefined || (t !== null && P.songDuration && t >= P.songDuration)) {
          toast('Thời gian dạng phút:giây, ví dụ 1:05.30, nằm trong bài hát', 'err');
          e.target.value = fmtT(s.start);
          return;
        }
        s.start = t;
        // độ dài đoạn = tới mốc đoạn kế tiếp
        it.forEach((x, k) => {
          const next = it.slice(k + 1).find((y) => y.start !== null);
          x.end = x.start === null ? null : next ? next.start : P.songDuration;
        });
        drawSections();
        save();
      };
    });
    markPlaying();
    playIcons();
  }

  /** Xếp clip không dùng AI: chia đều theo thứ tự, điệp khúc dùng lại clip. */
  async function autoAssign(quiet) {
    const every = Number($('#mEvery')?.value || 0);
    try {
      const r = await api('POST', '/api/music/assign', { lines: P.lines, clips: P.clips, every, reuseRepeats: true });
      P.lines = r.lines;
      P.introClip = null;
      P.arrange = null;
      if (!quiet) {
        drawLines();
        drawThumbs();
        save();
      }
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  // ---------- AI xếp clip ----------
  async function aiArrange() {
    if (ai) {
      ai.ac.abort();
      return;
    }
    if (!P.clips.length) return toast('Hãy tải clip ở mục 6 trước.', 'err');
    if (!P.lines.length) return toast('Chưa có lời — tải bài hát để AI nghe lời trước.', 'err');
    if (P.lines.some((l) => l.start === null) && !confirm('Còn câu chưa chấm nhịp — AI vẫn xếp được nhưng sẽ khớp nhạc tốt hơn khi đã chấm nhịp. Xếp luôn?')) return;
    ai = { kind: 'arrange', ac: new AbortController(), msg: '' };
    const setMsg = (m) => {
      ai.msg = m;
      drawArrange();
    };
    try {
      clearTimeout(saveT);
      await save(true);
      const need = P.clips.filter((f) => !P.clipInfo[f]?.desc);
      for (let i = 0; i < need.length; i++) {
        setMsg(`🤖 AI đang xem clip ${i + 1}/${need.length}…`);
        const d = await api('POST', `/api/music/${P.id}/ai/describe`, { file: need[i] }, { signal: ai.ac.signal });
        P.clipInfo[need[i]] = { ...(P.clipInfo[need[i]] || {}), desc: d.desc, tags: d.tags, energy: d.energy, mood: d.mood };
        drawThumbs();
      }
      setMsg('🤖 AI đang chọn clip cho từng câu hát…');
      const r = await serial(() => api('POST', `/api/music/${P.id}/ai/arrange`, { data: payload() }, { signal: ai.ac.signal }));
      Object.assign(P, { lines: r.lines, introClip: r.introClip, arrange: r.arrange, clipInfo: r.clipInfo, updatedAt: r.updatedAt });
      toast('AI đã xếp clip theo bài hát', 'ok');
    } catch (e) {
      if (ai.ac.signal.aborted) toast('Đã dừng AI');
      else toast(e.message, 'err');
    }
    ai = null;
    drawLines();
    drawThumbs();
  }

  // ---------- AI nghe bài hát: chép lời + chấm nhịp ----------
  async function aiTranscribe(auto) {
    if (ai) {
      if (!auto) ai.ac.abort();
      return;
    }
    if (!P.songUrl) return toast('Hãy tải bài hát ở mục 5 trước.', 'err');
    if (!auto && P.lines.length && !confirm(`AI sẽ nghe lại bài hát và thay toàn bộ ${P.lines.length} câu hiện có (kể cả chữ đã sửa tay). Tiếp tục?`)) return;
    stopTap();
    ai = { kind: 'transcribe', ac: new AbortController(), msg: `🎧 AI đang nghe bài hát (${fmtDur(P.songDuration)}) để chép lời và chấm nhịp từng câu… thường mất 20–90 giây` };
    drawLines();
    try {
      clearTimeout(saveT);
      await save(true);
      const r = await serial(() => api('POST', `/api/music/${P.id}/ai/transcribe`, { data: payload() }, { signal: ai.ac.signal }));
      Object.assign(P, { lines: r.lines, lyricsRaw: r.lyricsRaw, align: r.align, introClip: r.introClip, arrange: r.arrange, title: r.title, updatedAt: r.updatedAt });
      if ($('#mTitle')) $('#mTitle').value = P.title;
      toast(`AI đã chép ${r.lines.length} câu hát kèm thời gian. Kiểm tra chữ trong bảng ở mục 7, bấm ▶ để nghe thử.`, 'ok');
      warnLyricFixes();
    } catch (e) {
      if (ai.ac.signal.aborted) toast('Đã dừng AI');
      else toast(e.message, 'err');
    }
    ai = null;
    drawLines();
    drawThumbs();
    drawSum();
  }

  /** Thêm một câu trống cuối bảng (AI bỏ sót câu). */
  function addLine() {
    P.lines.push({ text: 'Câu mới', start: null, end: null, clip: P.lines[P.lines.length - 1]?.clip || null, alts: [] });
    drawLines();
    save();
    const inp = $$('.mrow[data-i] .mtx').pop();
    inp?.focus();
    inp?.select();
  }

  // ---------- AI chấm nhịp (giữ lời trong bảng, chỉ chấm lại thời gian) ----------
  async function aiAlign() {
    if (ai) {
      ai.ac.abort();
      return;
    }
    if (!P.songUrl) return toast('Hãy tải bài hát ở mục 5 trước.', 'err');
    if (!P.lines.length) return toast('Chưa có lời — bấm “AI nghe bài hát” trước.', 'err');
    const timed = P.lines.filter((l) => l.start !== null).length;
    if (timed && !confirm(`${timed}/${P.lines.length} câu đã có thời gian — AI sẽ chấm lại toàn bộ. Tiếp tục?`)) return;
    stopTap();
    ai = { kind: 'align', ac: new AbortController(), msg: `🎧 AI đang nghe bài hát (${fmtDur(P.songDuration)}) và chấm từng câu… thường mất 20–60 giây` };
    drawLines();
    try {
      clearTimeout(saveT);
      await save(true);
      const r = await serial(() => api('POST', `/api/music/${P.id}/ai/align`, { data: payload() }, { signal: ai.ac.signal }));
      Object.assign(P, { lines: r.lines, align: r.align, updatedAt: r.updatedAt });
      const a = r.align;
      toast(`AI đã chấm ${a.timed}/${a.total} câu${a.timed < a.total ? ' — câu trống sẽ được chia đều, hoặc chấm tay' : ''}. Bấm ▶ để nghe kiểm tra.`, a.timed ? 'ok' : 'err');
    } catch (e) {
      if (ai.ac.signal.aborted) toast('Đã dừng AI');
      else toast(e.message, 'err');
    }
    ai = null;
    drawLines();
  }

  /** Dời thời gian mọi câu (lời sớm / muộn đều so với giọng hát). */
  function shiftAll(d) {
    let n = 0;
    for (const l of P.lines) {
      if (l.start === null) continue;
      l.start = Math.max(0, Math.round((l.start + d) * 100) / 100);
      if (l.end !== null) l.end = Math.max(l.start + 0.1, Math.round((l.end + d) * 100) / 100);
      n++;
    }
    if (!n) return toast('Chưa có câu nào có thời gian.', 'err');
    drawLines();
    save();
    toast(`Đã dời ${n} câu ${d > 0 ? 'muộn' : 'sớm'} ${Math.abs(d)} giây`);
  }

  function drawArrange() {
    const box = $('#mArrange');
    if (!box) return;
    const a = P.arrange;
    const name = (f) => `Clip ${P.clips.indexOf(f) + 1}`;
    box.innerHTML = `<div class="mtools">
        <button class="btn primary" id="mAi" type="button" ${P.clips.length && P.lines.length && ai?.kind !== 'align' ? '' : 'disabled'}>${ai?.kind === 'arrange' ? '⏹ Dừng AI' : '🤖 AI tự xếp clip theo nhạc'}</button>
        <span class="hint" style="margin:0">${ai?.kind === 'arrange' ? esc(ai.msg) : 'AI xem từng clip, rồi chọn clip khớp lời, điệp khúc dùng lại clip, đoạn sôi động dùng clip sôi động.'}</span>
      </div>
      ${a && !ai ? `<div class="aibox">🤖 ${esc(a.notes || 'AI đã xếp clip.')}${a.unused?.length ? `<br><small>Không dùng: ${a.unused.filter((f) => P.clips.includes(f)).map(name).join(', ')}</small>` : ''}<small class="aimodel">${esc(a.model || '')}</small></div>` : ''}`;
    $('#mAi').onclick = aiArrange;
  }

  // ---------- clip ----------
  function uploadClips(files) {
    files = files.filter((f) => /^(video|image)\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv|avi|jpe?g|png|webp|bmp|gif)$/i.test(f.name));
    if (!files.length) return toast('Chỉ nhận file video (mp4, mov, webm…) hoặc ảnh.', 'err');
    const box = $('#mUploads');
    return serial(async () => {
      let n = 0;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const show = (pct) => box?.isConnected && (box.innerHTML = `<p class="hint">Đang tải clip ${i + 1}/${files.length}: ${esc(f.name)} — ${pct}</p>`);
        show('0%');
        try {
          const r = await upload(`/api/music/${P.id}/assets?kind=clip&name=${encodeURIComponent(f.name)}`, f, (x) => show(x < 1 ? Math.round(x * 100) + '%' : 'đang đọc clip…'));
          Object.assign(P, { clips: r.project.clips, clipNames: r.project.clipNames, clipInfo: r.project.clipInfo, clipList: r.project.clipList });
          n++;
          drawThumbs();
        } catch (e) {
          toast(`${f.name}: ${e.message}`, 'err');
        }
      }
      if (box?.isConnected) box.innerHTML = '';
      if (n) toast(`Đã thêm ${n} clip`, 'ok');
      drawLines();
      drawSum();
    });
  }
  const base = () => `/mfiles/${P.id}`;
  const clipUrl = (f) => `${base()}/clips/${f}`;
  const thumbUrl = (f) => (P.clipInfo[f]?.kind === 'image' ? clipUrl(f) : `${base()}/thumbs/thumb_${f.replace(/\.[^.]+$/, '')}.jpg`);
  const clipNo = (f) => P.clips.indexOf(f) + 1;

  function drawThumbs() {
    const box = $('#mThumbs');
    if (!box) return;
    const used = new Set([P.introClip, ...P.lines.flatMap((l) => [l.clip, ...(l.alts || [])])].filter(Boolean));
    if (selFor !== P.id) (sel = new Set()), (selFor = P.id);
    sel = new Set([...sel].filter((f) => P.clips.includes(f)));
    box.innerHTML = P.clips
      .map((f, i) => {
        const fx = P.clipFx[f] || [];
        const inf = P.clipInfo[f] || {};
        return `<div class="thumb mclip ${P.lines.length && !used.has(f) ? 'unused' : ''} ${sel.has(f) ? 'sel' : ''}" data-f="${esc(f)}" draggable="true">
          <div class="mv"><img src="${esc(thumbUrl(f))}" loading="lazy">${inf.kind === 'video' ? `<span class="dur">${inf.audio ? (P.options.muteClips ? '🔇 ' : '🔊 ') : ''}${inf.dur.toFixed(1)}s</span>` : '<span class="dur">ảnh</span>'}</div>
          <label class="pick" title="Chọn để xoá nhiều"><input type="checkbox" ${sel.has(f) ? 'checked' : ''}><span class="idx">${i + 1}</span></label><button class="del" type="button" title="Xoá clip">×</button>
          <div class="fxchips sm">${Object.entries(meta.effects).map(([k, v]) => `<button type="button" data-fx="${k}" class="${fx.includes(k) ? 'on' : ''}" title="${esc(v.label)}">${v.icon}</button>`).join('')}</div>
          <div class="nm" title="${esc(P.clipNames[f] || f)}">${esc(P.clipNames[f] || f)}</div>
          ${inf.desc ? `<div class="cdesc" title="${esc(inf.desc)}">🤖 ${esc(inf.desc)}${inf.energy ? ` <i>· sôi động ${inf.energy}/5</i>` : ''}</div>` : ''}
        </div>`;
      })
      .join('');
    const withAudio = P.clips.filter((f) => P.clipInfo[f]?.audio).length;
    if ($('#mAudCount')) $('#mAudCount').textContent = P.clips.length ? `(${withAudio}/${P.clips.length} clip có tiếng)` : '';
    drawSelBar(used);
    let dragF = null;
    $$('.thumb', box).forEach((t) => {
      const f = t.dataset.f;
      const mv = $('.mv', t);
      // rê chuột: phát clip (không tiếng)
      if (P.clipInfo[f]?.kind === 'video') {
        mv.addEventListener('mouseenter', () => {
          if ($('video', mv)) return;
          const v = document.createElement('video');
          Object.assign(v, { src: clipUrl(f), muted: true, loop: true, autoplay: true, playsInline: true });
          mv.appendChild(v);
        });
        mv.addEventListener('mouseleave', () => $('video', mv)?.remove());
      }
      $('.pick input', t).onchange = (e) => {
        e.target.checked ? sel.add(f) : sel.delete(f);
        t.classList.toggle('sel', e.target.checked);
        drawSelBar(used);
      };
      $('.del', t).onclick = () =>
        serial(async () => {
          if (!confirm(`Xoá clip ${clipNo(f)}?`)) return;
          try {
            const r = await api('DELETE', `/api/music/${P.id}/clips/${encodeURIComponent(f)}`);
            Object.assign(P, { clips: r.clips, clipNames: r.clipNames, clipInfo: r.clipInfo, clipFx: r.clipFx, lines: r.lines, introClip: r.introClip });
          } catch (e) {
            toast(e.message, 'err');
          }
          drawThumbs();
          drawLines();
          drawSum();
        });
      $$('[data-fx]', t).forEach((b) =>
        b.addEventListener('click', () => {
          const cur = new Set(P.clipFx[f] || []);
          cur.has(b.dataset.fx) ? cur.delete(b.dataset.fx) : cur.add(b.dataset.fx);
          P.clipFx[f] = [...cur];
          b.classList.toggle('on', cur.has(b.dataset.fx));
          save();
        }),
      );
      // kéo thả để đổi thứ tự (thứ tự dùng cho "Tự xếp" không AI)
      t.addEventListener('dragstart', () => ((dragF = f), t.classList.add('dragging')));
      t.addEventListener('dragend', () => t.classList.remove('dragging'));
      t.addEventListener('dragover', (e) => (e.preventDefault(), t.classList.add('target')));
      t.addEventListener('dragleave', () => t.classList.remove('target'));
      t.addEventListener('drop', (e) => {
        e.preventDefault();
        t.classList.remove('target');
        if (!dragF || dragF === f) return;
        const arr = P.clips.filter((x) => x !== dragF);
        arr.splice(arr.indexOf(f), 0, dragF);
        P.clips = arr;
        drawThumbs();
        drawLines();
        save();
      });
    });
  }

  /** Thanh chọn nhiều clip: chọn tất cả / chọn clip không dùng / xoá các clip đã chọn. */
  function drawSelBar(used) {
    const bar = $('#mClipSel');
    if (!bar) return;
    bar.hidden = P.clips.length < 2;
    const unused = P.lines.length ? P.clips.filter((f) => !used.has(f)) : [];
    const all = sel.size === P.clips.length;
    bar.innerHTML = `<button class="btn sm" type="button" data-s="all">${all ? '☐ Bỏ chọn tất cả' : '☑ Chọn tất cả'}</button>${unused.length ? `<button class="btn sm ghost" type="button" data-s="unused" title="Chọn các clip chưa được dùng cho câu hát nào">Chọn ${unused.length} clip không dùng</button>` : ''}${sel.size && !all ? '<button class="btn sm ghost" type="button" data-s="none">Bỏ chọn</button>' : ''}<button class="btn sm danger" type="button" data-s="del" ${sel.size ? '' : 'disabled'}>🗑 Xoá ${sel.size || ''} clip đã chọn</button><span class="hint">Tích ô ở góc clip để chọn nhiều.</span>`;
    const pick = (list) => ((sel = new Set(list)), drawThumbs());
    $('[data-s="all"]', bar).onclick = () => pick(all ? [] : P.clips);
    if ($('[data-s="unused"]', bar)) $('[data-s="unused"]', bar).onclick = () => pick(unused);
    if ($('[data-s="none"]', bar)) $('[data-s="none"]', bar).onclick = () => pick([]);
    $('[data-s="del"]', bar).onclick = () =>
      serial(async () => {
        const files = P.clips.filter((f) => sel.has(f));
        if (!files.length || !confirm(`Xoá ${files.length} clip đã chọn (${files.map((f) => clipNo(f)).join(', ')})? Không hoàn tác được.`)) return;
        try {
          const r = await api('POST', `/api/music/${P.id}/clips/delete`, { files });
          Object.assign(P, { clips: r.clips, clipNames: r.clipNames, clipInfo: r.clipInfo, clipFx: r.clipFx, lines: r.lines, introClip: r.introClip });
          sel = new Set();
          toast(`Đã xoá ${files.length} clip`, 'ok');
        } catch (e) {
          toast(e.message, 'err');
        }
        drawThumbs();
        drawLines();
        drawSum();
      });
  }

  function drawFxAll() {
    const box = $('#mFxAll');
    box.innerHTML = Object.entries(meta.effects)
      .map(([k, v]) => `<button type="button" data-fx="${k}" class="${P.options.fxAll.includes(k) ? 'on' : ''}">${v.icon} ${esc(v.label)}</button>`)
      .join('');
    $$('button', box).forEach((b) =>
      b.addEventListener('click', () => {
        const s = new Set(P.options.fxAll);
        s.has(b.dataset.fx) ? s.delete(b.dataset.fx) : s.add(b.dataset.fx);
        P.options.fxAll = [...s];
        b.classList.toggle('on', s.has(b.dataset.fx));
        save();
      }),
    );
  }

  /** Popup xem lại một clip. o: { label, text, remove() — có thì hiện nút "Bỏ clip phụ" }. */
  function viewClip(f, o = {}) {
    if (!f || !P.clips.includes(f)) return;
    const m = $('#modal');
    const inf = P.clipInfo[f] || {};
    const close = () => {
      m.hidden = true;
      m.innerHTML = '';
      m.onclick = null;
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => e.key === 'Escape' && close();
    m.innerHTML = `<div class="dlg cviewdlg"><div class="dh"><h3>Clip ${clipNo(f)}${o.label ? ` <small>· ${esc(o.label)}</small>` : ''}</h3><button class="vx" id="cvClose" type="button" aria-label="Đóng">×</button></div>
      <div class="db">
        <div class="cvstage">${inf.kind === 'video' ? `<video src="${esc(clipUrl(f))}" controls autoplay loop playsinline ${P.options.muteClips ? 'muted' : ''}></video>` : `<img src="${esc(clipUrl(f))}" alt="">`}</div>
        <div class="cvmeta"><b title="${esc(P.clipNames[f] || f)}">${esc(P.clipNames[f] || f)}</b><small>${inf.kind === 'video' ? `${(inf.dur || 0).toFixed(1)}s${inf.audio ? (P.options.muteClips ? ' · 🔇 đang tắt tiếng clip' : ' · 🔊 có tiếng') : ''}` : 'ảnh tĩnh'}${inf.energy ? ` · sôi động ${inf.energy}/5` : ''}</small></div>
        ${o.text ? `<p class="ptext">🎵 ${esc(o.text)}</p>` : ''}
        ${inf.desc ? `<p class="hint" style="margin:0">🤖 ${esc(inf.desc)}</p>` : ''}
        ${o.remove ? '<div class="btns"><button class="btn sm danger" id="cvRemove" type="button">Bỏ clip phụ này khỏi câu</button></div>' : ''}
      </div></div>`;
    m.hidden = false;
    $('#cvClose').onclick = close;
    m.onclick = (e) => e.target === m && close();
    document.addEventListener('keydown', onKey);
    if ($('#cvRemove')) $('#cvRemove').onclick = () => (close(), o.remove());
  }

  /**
   * Bảng chọn clip có xem trước: mở sẵn clip đang dùng, bấm một clip để xem, bấm đúp / "Dùng clip này" để chọn.
   * o: { title, text, cur, empty — có thì thêm ô "không chọn clip", exclude: clip không cho chọn, onPick(f|null) }.
   */
  function pickClip(o) {
    const m = $('#modal');
    const list = P.clips.filter((f) => !(o.exclude || []).includes(f));
    if (!list.length && !o.empty) return toast('Không còn clip nào để chọn', 'err');
    let focus = o.cur && list.includes(o.cur) ? o.cur : o.empty ? null : list[0];
    const close = () => {
      m.hidden = true;
      m.innerHTML = '';
      m.onclick = null;
      document.removeEventListener('keydown', onKey);
    };
    const pick = (f) => (close(), f !== o.cur && o.onPick(f));
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'Enter' && !/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target.tagName)) pick(focus);
    };
    m.innerHTML = `<div class="dlg cpickdlg"><div class="dh"><h3>${esc(o.title || 'Chọn clip')}</h3><button class="vx" id="cpClose" type="button" aria-label="Đóng">×</button></div>
      <div class="db">
        ${o.text ? `<p class="ptext">🎵 ${esc(o.text)}</p>` : ''}
        <div class="cpview"><div class="cvstage" id="cpStage"></div><div class="cpside"><div id="cpMeta"></div>
          <div class="btns"><button class="btn primary" id="cpUse" type="button"></button><button class="btn ghost" id="cpCancel" type="button">Huỷ</button></div>
          <p class="hint" style="margin:0">Bấm một clip để xem trước, bấm đúp để chọn luôn.</p></div></div>
        <div class="cpgrid">${o.empty ? `<button type="button" class="cpi none" data-k=""><i>∅</i><span>${esc(o.empty)}</span></button>` : ''}${list
          .map((f) => {
            const inf = P.clipInfo[f] || {};
            return `<button type="button" class="cpi ${f === o.cur ? 'cur' : ''}" data-k="${esc(f)}" title="${esc(inf.desc || P.clipNames[f] || f)}"><img src="${esc(thumbUrl(f))}" loading="lazy"><b>${clipNo(f)}</b>${f === o.cur ? '<em>đang dùng</em>' : ''}${inf.kind === 'video' ? `<small class="d">${(inf.dur || 0).toFixed(1)}s</small>` : ''}<span>${esc(P.clipNames[f] || f)}</span></button>`;
          })
          .join('')}</div>
      </div></div>`;
    const show = () => {
      const inf = (focus && P.clipInfo[focus]) || {};
      $('#cpStage').innerHTML = !focus
        ? `<div class="cpnone">${esc(o.empty)}</div>`
        : inf.kind === 'video'
          ? `<video src="${esc(clipUrl(focus))}" controls autoplay loop playsinline ${P.options.muteClips ? 'muted' : ''}></video>`
          : `<img src="${esc(clipUrl(focus))}" alt="">`;
      $('#cpMeta').innerHTML = focus
        ? `<b>Clip ${clipNo(focus)}${focus === o.cur ? ' <em>· đang dùng</em>' : ''}</b><small title="${esc(P.clipNames[focus] || focus)}">${esc(P.clipNames[focus] || focus)}</small><small>${inf.kind === 'video' ? `${(inf.dur || 0).toFixed(1)}s` : 'ảnh tĩnh'}${inf.energy ? ` · sôi động ${inf.energy}/5` : ''}</small>${inf.desc ? `<p class="hint" style="margin:0">🤖 ${esc(inf.desc)}</p>` : ''}`
        : `<b>${esc(o.empty)}</b>`;
      $('#cpUse').textContent = focus === o.cur ? 'Giữ clip này' : focus ? `Dùng clip ${clipNo(focus)}` : `Chọn: ${o.empty}`;
      $$('.cpi', m).forEach((b) => b.classList.toggle('on', (b.dataset.k || null) === focus));
    };
    m.hidden = false;
    show();
    $('.cpi.on', m)?.scrollIntoView({ block: 'nearest' });
    $$('.cpi', m).forEach((b) => {
      b.onclick = () => ((focus = b.dataset.k || null), show());
      b.ondblclick = () => pick(b.dataset.k || null);
    });
    $('#cpUse').onclick = () => pick(focus);
    $('#cpCancel').onclick = close;
    $('#cpClose').onclick = close;
    m.onclick = (e) => e.target === m && close();
    document.addEventListener('keydown', onKey);
  }

  // ---------- bảng câu hát ----------
  function drawLines() {
    drawArrange();
    const tools = $('#mLinesTools');
    const rows = $('#mRows');
    if (!rows) return;
    if (!P.lines.length) {
      tools.innerHTML = '';
      $('#mTap').innerHTML = '';
      rows.innerHTML = !P.songUrl
        ? '<p class="hint">Tải bài hát ở mục 5 — AI sẽ tự nghe để chép lời và chấm nhịp từng câu.</p>'
        : `<div class="mempty"><button class="btn primary" id="mAiTx" type="button" ${ai && ai.kind !== 'transcribe' ? 'disabled' : ''}>${ai?.kind === 'transcribe' ? '⏹ Dừng AI' : '🤖 AI nghe bài hát → chép lời + chấm nhịp'}</button>
          <span class="hint" style="margin:0">${ai?.kind === 'transcribe' ? esc(ai.msg) : 'Chưa có lời. Cần key Gemini trong Cài đặt (Gemini nghe được nhạc).'}</span>
          <button class="btn ghost" id="mAddLine0" type="button" ${ai ? 'disabled' : ''}>✍️ Tự gõ lời</button></div>`;
      if ($('#mAiTx')) $('#mAiTx').onclick = () => aiTranscribe();
      if ($('#mAddLine0')) $('#mAddLine0').onclick = addLine;
      return;
    }
    const timed = P.lines.filter((l) => l.start !== null).length;
    const fixCount = findLyricFixes().reduce((a, f) => a + f.n, 0);
    const pickBtn = (cur, empty, id = '') => `<button type="button" class="mpick" ${id ? `id="${id}"` : ''} title="Bấm để xem và chọn clip">${cur ? `<img src="${esc(thumbUrl(cur))}">` : '<i></i>'}<span>${cur ? `Clip ${clipNo(cur)}` : empty}</span><b>▾</b></button>`;
    tools.innerHTML = `<div class="mtools" style="margin-top:12px">
      <button class="btn primary" id="mAiTx" type="button" ${P.songUrl && (!ai || ai.kind === 'transcribe') ? '' : 'disabled'} title="Nghe lại bài hát, chép lại lời + chấm nhịp (thay toàn bộ bảng)">${ai?.kind === 'transcribe' ? '⏹ Dừng AI' : '🤖 AI nghe lại lời'}</button>
      <button class="btn" id="mAiAlign" type="button" ${P.songUrl && (!ai || ai.kind === 'align') ? '' : 'disabled'} title="Giữ chữ trong bảng (đã sửa tay), AI chỉ chấm lại thời gian">${ai?.kind === 'align' ? '⏹ Dừng AI' : '⏱ AI chấm lại thời gian'}</button>
      ${fixCount ? `<button class="btn danger" id="mFixLyr" type="button" ${ai ? 'disabled' : ''} title="Sửa các chữ AI hay chép sai (Bôm → Bom)">✏️ Sửa lời sai (${fixCount})</button>` : ''}
      <button class="btn" id="mTapBtn" type="button" ${ai ? 'disabled' : ''}>🎯 Chấm tay</button>
      <span class="inline mshift" title="Dời thời gian tất cả câu (khi lời hiện sớm / muộn đều so với giọng hát)"><button class="btn sm" id="mShiftM" type="button">−0.1s</button><button class="btn sm" id="mShiftP" type="button">+0.1s</button></span>
      <span class="hint" style="margin:0">${ai?.kind === 'align' || ai?.kind === 'transcribe' ? esc(ai.msg) : `${timed}/${P.lines.length} câu đã có thời gian${P.align?.notes ? ` · 🤖 ${esc(P.align.notes)}` : ''}`}</span>
      <span class="sp1"></span>
      <label class="inline" style="font-size:13px;color:var(--muted)">Xếp không AI: <select id="mEvery" style="width:auto;padding:5px 8px"><option value="0">chia đều</option>${[1, 2, 3, 4, 6].map((n) => `<option value="${n}">đổi mỗi ${n} câu</option>`).join('')}</select></label>
      <button class="btn" id="mAssign" type="button" ${P.clips.length ? '' : 'disabled'}>🎞 Tự xếp</button>
      <button class="btn ghost danger" id="mClearT" type="button" title="Xoá hết thời gian đã chấm">⟲ Xoá thời gian</button>
    </div>
    <div class="mrow mintro"><span class="mn">♪</span><span></span><span class="mt muted">0:00.00</span><span class="mtx muted">Nhạc dạo (trước câu 1)</span>
      <span class="mimg">${pickBtn(P.introClip, '— như câu 1 —', 'mIntroClip')}</span><span></span><span></span></div>`;
    $('#mTapBtn').onclick = () => (tap ? stopTap() : startTap());
    $('#mAiAlign').onclick = aiAlign;
    if ($('#mFixLyr'))
      $('#mFixLyr').onclick = () => {
        const found = findLyricFixes();
        toast(`Sắp sửa ${found.reduce((a, f) => a + f.n, 0)} chữ: ${fixSummary(found)}.`, '', { ms: FIX_MS });
        fixLyrics();
      };
    $('#mAiTx').onclick = () => aiTranscribe();
    $('#mShiftM').onclick = () => shiftAll(-0.1);
    $('#mShiftP').onclick = () => shiftAll(0.1);
    $('#mAssign').onclick = () => autoAssign();
    $('#mClearT').onclick = () => {
      if (!confirm('Xoá thời gian của tất cả câu?')) return;
      P.lines.forEach((l) => (l.start = l.end = null));
      drawLines();
      save();
    };
    $('#mIntroClip').onclick = () =>
      pickClip({
        title: 'Clip cho nhạc dạo',
        cur: P.introClip,
        empty: 'Như câu 1',
        onPick: (f) => {
          P.introClip = f;
          drawLines();
          drawThumbs();
          save();
        },
      });

    rows.innerHTML = P.lines
      .map(
        (l, i) => `<div class="mrow ${tap && tap.ptr === i ? 'next' : ''}" data-i="${i}">
        <span class="mn">${i + 1}</span>
        <button class="ib mplay" type="button" data-play="l${i}" ${l.start === null ? 'disabled' : ''}>▶</button>
        <input class="mt" type="text" value="${fmtT(l.start)}" placeholder="--:--" title="Bắt đầu (phút:giây)">
        <input class="mtx" type="text" value="${esc(l.text)}">
        <span class="mimg">${pickBtn(l.clip, '— giữ clip trước —')}</span>
        <span class="malts" title="Clip phụ: nối tiếp khi câu dài hơn clip chính">${(l.alts || []).map((f) => `<button type="button" class="alt" data-alt="${esc(f)}" title="Bấm để xem clip phụ"><img src="${esc(thumbUrl(f))}"><b>${clipNo(f)}</b></button>`).join('')}${l.clip && P.clips.length > 1 && (l.alts || []).length < 3 ? `<button type="button" class="madd" title="Thêm clip phụ">＋</button>` : ''}</span>
        <button class="ib mdel" type="button" title="Xoá câu">×</button>
      </div>`,
      )
      .join('') + `<button class="btn ghost sm maddline" id="mAddLine" type="button" ${ai ? 'disabled' : ''}>＋ Thêm câu (AI bỏ sót)</button>`;
    playIcons();
    $('#mAddLine').onclick = addLine;
    $$('.mrow', rows).forEach((r) => {
      const i = Number(r.dataset.i);
      const l = P.lines[i];
      $('.mplay', r).onclick = () => {
        const next = P.lines.slice(i + 1).find((x) => x.start !== null)?.start;
        playFrom(Math.max(0, l.start - 0.3), 'l' + i, (l.end ?? next ?? l.start + 8) + 0.3);
      };
      $('.mt', r).onchange = (e) => {
        const t = parseT(e.target.value);
        if (t === undefined) {
          toast('Thời gian dạng phút:giây, ví dụ 1:05.30', 'err');
          e.target.value = fmtT(l.start);
          return;
        }
        l.start = t;
        if (t !== null && l.end !== null && l.end <= t) l.end = null;
        e.target.value = fmtT(t);
        $('.mplay', r).disabled = t === null;
        save();
      };
      $('.mtx', r).onchange = (e) => ((l.text = e.target.value.trim() || l.text), save());
      $('.mpick', r).onclick = () =>
        pickClip({
          title: `Clip cho câu ${i + 1}`,
          text: l.text,
          cur: l.clip,
          empty: 'Giữ clip trước',
          onPick: (f) => {
            l.clip = f;
            l.alts = (l.alts || []).filter((x) => x !== l.clip);
            drawLines();
            drawThumbs();
            save();
          },
        });
      $$('.alt', r).forEach((b) =>
        b.addEventListener('click', () =>
          viewClip(b.dataset.alt, {
            label: `Câu ${i + 1} · clip phụ`,
            text: l.text,
            remove: () => {
              l.alts = l.alts.filter((f) => f !== b.dataset.alt);
              drawLines();
              drawThumbs();
              save();
            },
          }),
        ),
      );
      const add = $('.madd', r);
      if (add)
        add.onclick = () =>
          pickClip({
            title: `Thêm clip phụ cho câu ${i + 1}`,
            text: l.text,
            exclude: [l.clip, ...(l.alts || [])],
            onPick: (f) => {
              l.alts = [...(l.alts || []), f];
              drawLines();
              drawThumbs();
              save();
            },
          });
      $('.mdel', r).onclick = () => {
        P.lines.splice(i, 1);
        drawLines();
        save();
      };
    });
    drawTap();
  }

  /**
   * Phát bài hát từ giây t. key: nút ▶ đang nghe (bấm lại = dừng); end: tự dừng ở giây này.
   */
  function playFrom(t, key, end) {
    const au = $('#mAudio');
    if (!au) return toast('Chưa có bài hát.', 'err');
    if (key && listen?.key === key && !au.paused) return au.pause();
    au.currentTime = t;
    listen = key ? { key, end: end > t ? end : null } : null;
    au.play();
    playIcons();
  }
  /** Nút ▶ của đoạn / câu đang nghe đổi thành ⏹. */
  function playIcons() {
    const au = $('#mAudio');
    const on = au && !au.paused && listen ? listen.key : null;
    $$('[data-play]').forEach((b) => {
      b.textContent = b.dataset.play === on ? '⏹' : '▶';
      b.classList.toggle('on', b.dataset.play === on);
      b.title = b.dataset.play === on ? 'Dừng' : b.dataset.play[0] === 's' ? 'Nghe đoạn này' : 'Nghe câu này';
    });
  }

  // câu đang hát sáng lên khi nghe
  function markPlaying() {
    const au = $('#mAudio');
    if (!au) return;
    const t = au.currentTime;
    let sec = -1;
    (P.sections?.items || []).forEach((s, i) => {
      if (s.start !== null && s.start <= t) sec = i;
    });
    $$('.msec[data-i]').forEach((r) => r.classList.toggle('cur', Number(r.dataset.i) === sec));
    if (!P.lines.length) return;
    let cur = -1;
    P.lines.forEach((l, i) => {
      if (l.start !== null && l.start <= t) cur = i;
    });
    $$('.mrow[data-i]').forEach((r) => r.classList.toggle('cur', Number(r.dataset.i) === cur));
    if (tap && $('#mTapNow')) $('#mTapNow').textContent = fmtT(t);
  }

  // ---------- chấm nhịp ----------
  function startTap() {
    const au = $('#mAudio');
    if (!au) return toast('Hãy tải bài hát ở mục 5 trước.', 'err');
    let ptr = P.lines.findIndex((l) => l.start === null);
    if (ptr < 0) ptr = 0;
    tap = { ptr };
    document.addEventListener('keydown', onTapKey);
    drawLines();
    const from = ptr > 0 && P.lines[ptr - 1].start !== null ? Math.max(0, P.lines[ptr - 1].start - 1) : 0;
    playFrom(from);
    $('#mTap').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function stopTap() {
    if (!tap) return;
    tap = null;
    document.removeEventListener('keydown', onTapKey);
    $('#mAudio')?.pause();
    if ($('#mRows')) drawLines();
    save();
  }
  function drawTap() {
    const box = $('#mTap');
    if (!box) return;
    if ($('#mTapBtn')) $('#mTapBtn').textContent = tap ? '⏹ Dừng chấm nhịp' : '🎯 Chấm tay';
    if (!tap) return (box.innerHTML = '');
    const l = P.lines[tap.ptr];
    const prev = P.lines[tap.ptr - 1];
    box.innerHTML = `<div class="mtap">
      <div class="mtap-l"><small>Câu ${tap.ptr + 1}/${P.lines.length} — bấm khi giọng hát <b>bắt đầu</b> câu:</small><div class="mtap-next">${l ? esc(l.text) : '✅ Đã chấm hết. Bấm Dừng để lưu.'}</div>${prev ? `<small>Vừa chấm: ${esc(prev.text)} · ${fmtT(prev.start)}</small>` : ''}</div>
      <div class="mtap-r"><b id="mTapNow">0:00.00</b>
        <button class="btn primary big" id="mTapHit" type="button" ${l ? '' : 'disabled'}>Space · Bắt đầu câu</button>
        <button class="btn" id="mTapEnd" type="button" ${prev ? '' : 'disabled'}>K · Hết câu (trước nhạc dạo)</button>
        <button class="btn ghost" id="mTapBack" type="button" ${tap.ptr ? '' : 'disabled'}>← Chấm lại câu trước</button>
        <label class="inline" style="font-size:12px;color:var(--muted)">Bù phản xạ <input type="number" id="mOffset" min="0" max="1" step="0.05" value="${offset}" style="width:70px;padding:4px 6px"> giây</label>
      </div></div>`;
    $('#mTapHit').onclick = tapHit;
    $('#mTapEnd').onclick = tapEnd;
    $('#mTapBack').onclick = tapBack;
    $('#mOffset').onchange = (e) => {
      offset = Math.max(0, Math.min(1, Number(e.target.value) || 0));
      try {
        localStorage.setItem('gva.music.offset', String(offset));
      } catch (_) {}
    };
    $(`.mrow[data-i="${tap.ptr}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  const now = () => Math.max(0, ($('#mAudio')?.currentTime || 0) - offset);
  function tapHit() {
    const l = P.lines[tap.ptr];
    if (!l) return;
    l.start = Math.round(now() * 100) / 100;
    if (l.end !== null && l.end <= l.start) l.end = null;
    // các câu sau đang có thời gian sớm hơn -> xoá để chấm lại
    for (let k = tap.ptr + 1; k < P.lines.length; k++) if (P.lines[k].start !== null && P.lines[k].start <= l.start) P.lines[k].start = P.lines[k].end = null;
    tap.ptr++;
    drawLines();
  }
  function tapEnd() {
    const l = P.lines[tap.ptr - 1];
    if (!l) return;
    const t = Math.round(now() * 100) / 100;
    if (t > l.start) l.end = t;
    drawLines();
    toast(`Câu ${tap.ptr}: kết thúc ${fmtT(t)}`);
  }
  function tapBack() {
    if (!tap.ptr) return;
    tap.ptr--;
    const l = P.lines[tap.ptr];
    const back = l.start !== null ? Math.max(0, l.start - 2) : Math.max(0, now() - 3);
    l.start = l.end = null;
    drawLines();
    playFrom(back);
  }
  function onTapKey(e) {
    if (!tap || !active()) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.code === 'Space' || e.key === ' ') tapHit();
    else if (e.key === 'k' || e.key === 'K') tapEnd();
    else if (e.key === 'ArrowLeft' || e.key === 'Backspace') tapBack();
    else if (e.key === 'Escape') stopTap();
    else return;
    e.preventDefault();
  }

  // ---------- dựng ----------
  function drawSum() {
    const el = $('#mSum');
    if (!el) return;
    const o = P.options;
    const res = o.orientation === 'portrait' ? `${o.resolution}×${Math.round((o.resolution * 16) / 9 / 2) * 2}` : `${Math.round((o.resolution * 16) / 9 / 2) * 2}×${o.resolution}`;
    el.innerHTML = `<b>${o.orientation === 'portrait' ? '9:16' : '16:9'}</b> ${res} · ${P.songUrl ? `🎵 ${fmtDur(P.songDuration)}` : '<span style="color:var(--warn)">chưa có bài hát</span>'} · ${P.lines.length} câu · ${P.clips.length} clip${BUMPERS.map(([k]) => (bump[k] ? ` · 🎬 ${k} ${fmtDur(bump[k].dur)}` : bump[k] === null ? ` · <span style="color:var(--warn)">chưa có ${k}</span>` : '')).join('')}${logo ? ' · 🏷 logo' : logo === null ? ' · <span style="color:var(--warn)">chưa có logo</span>' : ''}`;
    $('#mRun').textContent = busy() ? '⏹ Huỷ' : '🎬 Dựng video nhạc';
    $('#mRun').classList.toggle('primary', !busy());
  }

  async function run() {
    if (busy()) {
      try {
        P = { ...P, ...(await api('POST', `/api/music/${P.id}/cancel`)) };
      } catch (e) {
        toast(e.message, 'err');
      }
      return;
    }
    stopTap();
    if (!P.name?.trim()) {
      toast('Chưa có tên dự án. Hãy nhập Tên dự án ở đầu trang — thư mục dự án sẽ đặt theo tên này.', 'err');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return $('#mName').focus();
    }
    if (!fileName(P.title)) {
      toast('Chưa có tên video. Hãy nhập Tên video (mục 4 Khổ video) — file video xuất ra sẽ lấy theo tên này.', 'err');
      $('#mTitle').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return $('#mTitle').focus();
    }
    for (const [k, n] of BUMPERS)
      if (bump[k] === null) {
        toast(`Chưa có video ${k}. Hãy tải video ${k} (mục ${n}) trước khi dựng.`, 'err');
        return $(`#m${cap(k)}Drop`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    if (logo === null) {
      toast('Chưa có logo kênh. Hãy tải logo (mục 3) trước khi dựng.', 'err');
      return $('#mLogoDrop')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    const untimed = P.lines.filter((l) => l.start === null).length;
    if (P.options.captions.on && untimed && !confirm(`${untimed}/${P.lines.length} câu chưa chấm nhịp — app sẽ chia đều thời gian nên lời có thể lệch giọng hát. Vẫn dựng?`)) return;
    clearTimeout(saveT);
    await serial(async () => {
      try {
        P = await api('POST', `/api/music/${P.id}/run`, { data: payload() });
        remember(P.id); // thư mục (id) có thể vừa đổi theo tên dự án
        drawDir();
        drawList();
        drawResult();
        drawSum();
        startPoll();
        $('#mResult').scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (e) {
        toast(e.message, 'err');
      }
    });
  }

  function startPoll() {
    clearInterval(pollT);
    pollT = setInterval(async () => {
      if (!active() || !P) return clearInterval(pollT);
      try {
        const r = await api('GET', `/api/music/${P.id}`);
        if (r.id !== P.id) return;
        Object.assign(P, { status: r.status, progress: r.progress, message: r.message, error: r.error, logs: r.logs, files: r.files, videoFile: r.videoFile, videoUrl: r.videoUrl, videoDuration: r.videoDuration, updatedAt: r.updatedAt, beats: r.beats });
        drawResult();
        drawSum();
        if (!busy()) {
          clearInterval(pollT);
          if (r.status === 'done') toast('Đã dựng xong video nhạc 🎉', 'ok');
          drawList();
        }
      } catch (_) {}
    }, 1000);
  }

  function drawResult() {
    const box = $('#mResult');
    if (!box) return;
    if (!busy() && !P.videoUrl && P.status !== 'error' && P.status !== 'canceled') {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const pct = P.status === 'done' ? 100 : Number(P.progress) || 0;
    const keepVideo = $('#mVideo') && $('#mVideo').dataset.src === P.videoUrl;
    if (!keepVideo || busy()) {
      const logs = $('#mLogs');
      const logOpen = !!logs?.closest('details')?.open;
      const logScroll = logs?.scrollTop || 0;
      box.innerHTML = `<h2>Kết quả <span class="pill ${P.status}">${STATUS[P.status] || P.status}</span></h2>
        <div class="status-line"><span class="msg" id="mMsg"></span><b id="mPct"></b></div>
        <div class="bar"><i id="mBar"></i></div>
        <div id="mErr"></div>
        ${P.videoUrl && !busy() ? `<div class="box"><video id="mVideo" data-src="${esc(P.videoUrl)}" controls src="${esc(P.videoUrl)}"></video>
          <div class="btns"><a class="btn primary" href="${esc(P.videoUrl)}&download=1">⬇ Tải MP4</a><a class="btn" href="${base()}/lyrics.srt?download=1">SRT lời</a><a class="btn" href="${base()}/lyrics.lrc?download=1">LRC lời</a><button class="btn" id="mReveal" type="button">📂 Mở trong Finder</button></div>
          <p class="hint">Đăng YouTube nhớ chọn “Nội dung dành cho trẻ em”. File SRT có thể tải lên làm phụ đề YouTube.</p></div>` : ''}
        <details><summary>Nhật ký chi tiết</summary><div class="logs" id="mLogs"></div></details>`;
      if (logOpen) $('#mLogs').closest('details').open = true;
      $('#mLogs').dataset.scroll = logScroll;
      if ($('#mReveal')) $('#mReveal').onclick = () => api('POST', `/api/music/${P.id}/reveal`).catch((e) => toast(e.message, 'err'));
    }
    $('#mMsg').textContent = P.message || '';
    $('#mPct').textContent = busy() ? Math.round(pct) + '%' : '';
    $('#mBar').style.width = pct + '%';
    $('#mErr').innerHTML = P.status === 'error' && P.error ? `<div class="err">${esc(P.error)}</div>` : '';
    const logs = $('#mLogs');
    const atEnd = logs.scrollTop + logs.clientHeight >= logs.scrollHeight - 4;
    logs.textContent = (P.logs || []).map((l) => `${l.t}  ${l.msg}`).join('\n');
    if (logs.dataset.scroll !== undefined) (logs.scrollTop = Number(logs.dataset.scroll)), delete logs.dataset.scroll;
    else if (atEnd) logs.scrollTop = logs.scrollHeight;
  }

  window.addEventListener('hashchange', () => {
    if (active()) return;
    clearInterval(pollT);
    ai?.ac.abort();
    if (tap) {
      tap = null;
      document.removeEventListener('keydown', onTapKey);
    }
    if (P) save(true);
  });

  window.GVAMusic = { render };
})();
