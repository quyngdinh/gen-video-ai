(() => {
  'use strict';

  // ---------- tiện ích ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const getp = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  const setp = (o, p, v) => {
    const ks = p.split('.');
    const last = ks.pop();
    ks.reduce((a, k) => (a[k] ??= {}), o)[last] = v;
  };

  async function api(method, path, body) {
    const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let j = null;
    try {
      j = await res.json();
    } catch (_) {}
    if (!res.ok) throw new Error((j && j.error) || 'Lỗi ' + res.status);
    return j;
  }

  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), type === 'err' ? 7000 : 3500);
  }

  const fmtDur = (s) => {
    s = Math.round(s || 0);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };

  // ---------- trạng thái ----------
  const PROVIDER_DEFAULTS = {
    elevenlabs: { modelId: 'eleven_multilingual_v2', languageCode: 'vi' },
    minimax: { modelId: 'speech-2.8-turbo', languageCode: 'Vietnamese' },
    capcut: { modelId: 'capcut', languageCode: 'vi' },
  };

  const DEFAULT_FORM = () => ({
    title: '',
    script: '',
    scenePrompts: null, // prompt tạo ảnh từng cảnh (xem genPrompts)
    options: {
      orientation: 'landscape',
      resolution: 1080,
      fps: 30,
      fit: 'blur',
      bgColor: '#ffffff',
      motion: 'none',
      transition: 'none',
      maxScene: 8,
      tail: 0.6,
      normalizeAudio: true,
      captions: { on: true, preset: 'classic', position: 'bottom', sizeMul: 1, uppercase: false, maxChars: 56 },
      music: { volume: 0.12 },
      voice: { provider: 'elevenlabs', modelId: 'eleven_multilingual_v2', voiceId: '', voiceName: '', languageCode: 'vi', speed: 1, stability: 0.5, similarityBoost: 0.75, style: 0 },
    },
  });

  let settings = null;
  let health = null;
  let form = DEFAULT_FORM();
  let images = []; // { key, file (tên trên server) | null, blob | null, name, url }
  let bgm = null; // { file, blob, name }
  let projectId = null;
  let project = null;
  let busy = false;
  let pollTimer = null;
  let nextKey = 1;

  try {
    const saved = JSON.parse(localStorage.getItem('gva.form.v1') || 'null');
    if (saved) form = deepMerge(DEFAULT_FORM(), saved);
  } catch (_) {}
  form.options.motion = 'none'; // đã bỏ zoom / lia
  const hadSavedVoice = !!form.options.voice.voiceId;

  function deepMerge(a, b) {
    for (const k of Object.keys(b || {})) {
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) a[k] = deepMerge(a[k] && typeof a[k] === 'object' ? a[k] : {}, b[k]);
      else a[k] = b[k];
    }
    return a;
  }
  let saveT;
  function saveForm() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      try {
        localStorage.setItem('gva.form.v1', JSON.stringify(form));
      } catch (_) {}
    }, 300);
  }

  // ---------- điều hướng ----------
  const pages = { create: renderCreate, music: () => window.GVAMusic.render(), projects: renderProjects, settings: renderSettings };
  function route() {
    const name = (location.hash.replace(/^#\//, '') || 'create').split('?')[0];
    const key = pages[name] ? name : 'create';
    $$('nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
    stopListPoll();
    pages[key]();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  async function refreshHealth() {
    try {
      [settings, health] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/health')]);
    } catch (e) {
      toast(e.message, 'err');
    }
    drawSide();
    refreshCredits();
  }

  // ----- sidebar: genmax (+ credit), AI đang dùng, FFmpeg -----
  const AI_NAMES = { anthropic: 'Claude', gemini: 'Gemini' };
  let aiCheck = { sig: '', state: '', msg: '' }; // kết quả kiểm tra key AI gần nhất
  async function checkAi(sig) {
    aiCheck = { sig, state: 'checking', msg: '' };
    drawSide();
    try {
      const r = await api('POST', '/api/ai/test?provider=' + settings.aiProvider, {});
      if (aiCheck.sig === sig) aiCheck = { sig, state: r.ok ? 'ok' : 'bad', msg: r.ok ? '' : r.message || 'Key không hợp lệ' };
    } catch (e) {
      if (aiCheck.sig === sig) aiCheck = { sig, state: 'bad', msg: e.message };
    }
    drawSide();
  }

  function drawSide() {
    const box = $('#sideStatus');
    if (!box || !settings) return;
    const s = settings;
    const ff = health?.ffmpeg;
    const gm = s.apiKeySet
      ? `<div class="chip ${creditsErr ? 'warn' : 'ok'}" title="${creditsErr ? esc(creditsErr) : 'Số credit còn lại của API key genmax'}"><i></i><span>API genmax ${esc(s.apiKeyHint)}<small>${credits != null ? Number(credits).toLocaleString('vi-VN') + ' credit' : creditsErr ? 'không đọc được credit' : 'đang đọc credit…'}</small></span></div>`
      : `<div class="chip bad"><i></i>API genmax chưa nhập<a href="#/settings">Nhập</a></div>`;
    // AI: nhà cung cấp đang chọn + model; tự kiểm tra lại key khi cài đặt thay đổi
    const prov = s.aiProvider || 'anthropic';
    const name = AI_NAMES[prov] || prov;
    const f = AI_FIELDS[prov] || AI_FIELDS.anthropic;
    const model = s[f[1]] || '';
    let ai;
    if (!s[f[0]]) ai = `<div class="chip"><i></i>AI ${name} chưa nhập key<a href="#/settings">Cài</a></div>`;
    else {
      const sig = [prov, s[f[0].replace('Set', 'Hint')], model].join('|');
      if (aiCheck.sig !== sig) checkAi(sig);
      const st = aiCheck.state;
      const sub = st === 'bad' ? 'key lỗi — bấm để xem' : st === 'checking' || !st ? 'đang kiểm tra…' : model ? model : 'chưa chọn model';
      const cls = st === 'bad' ? 'bad' : st === 'ok' ? (model ? 'ok' : 'warn') : '';
      ai = `<a class="chip ${cls}" href="#/settings" title="${esc(aiCheck.msg || `AI dùng cho xếp ảnh, gợi ý hiệu ứng, tạo prompt: ${name}${model ? ' · ' + model : ''}`)}"><i></i><span>AI ${name}<small>${esc(sub)}</small></span></a>`;
    }
    const ffc = `<div class="chip ${ff?.ok ? (ff.libass ? 'ok' : 'warn') : 'bad'}"><i></i>FFmpeg ${ff?.ok ? (ff.libass ? 'sẵn sàng' : 'thiếu libass') : 'chưa cài'}</div>`;
    box.innerHTML = gm + ai + ffc;
  }

  // ---------- trang: TẠO VIDEO ----------
  const seg = (k, opts) =>
    `<div class="seg">${opts.map(([v, label, sub]) => `<button type="button" data-k="${k}" data-v="${v}">${label}${sub ? `<small>${sub}</small>` : ''}</button>`).join('')}</div>`;

  function renderCreate() {
    const app = $('#app');
    app.innerHTML = `
      <div class="page-head"><h1>Tạo video</h1><div class="inline"><button class="btn ghost" id="btnNew">+ Dự án mới</button></div></div>
      <div id="banners"></div>

      <section class="card"><h2><span class="num">1</span>Định dạng video</h2>
        <div class="choice-row">
          <button type="button" class="choice" data-k="options.orientation" data-v="landscape"><span class="shape land"></span><b>Long form</b><small>16:9 · YouTube</small></button>
          <button type="button" class="choice" data-k="options.orientation" data-v="portrait"><span class="shape port"></span><b>Short form</b><small>9:16 · TikTok, Reels, Shorts</small></button>
        </div>
        <div class="row">
          <div class="field"><span class="lbl">Độ phân giải</span>${seg('options.resolution', [[480, '480p', 'xem thử nhanh'], [720, '720p'], [1080, '1080p', 'khuyên dùng'], [1440, '1440p', 'nặng']])}</div>
          <div class="field"><span class="lbl">Khung hình / giây</span>${seg('options.fps', [[24, '24'], [30, '30'], [60, '60']])}</div>
        </div>
        <p class="hint" id="sizeInfo"></p>
      </section>

      <section class="card"><h2><span class="num">2</span>Giọng đọc &amp; kịch bản</h2>
        <div class="row">
          <div class="field"><label>Nhà cung cấp giọng (qua genmax)</label>
            <select data-k="options.voice.provider"><option value="elevenlabs">ElevenLabs</option><option value="minimax">MiniMax</option><option value="capcut">CapCut</option></select></div>
          <div class="field"><label>Model</label><select data-k="options.voice.modelId" id="modelSel"></select><small id="modelDesc"></small></div>
          <div class="field"><label>Ngôn ngữ (language_code)</label><input type="text" list="langs" data-k="options.voice.languageCode" /><datalist id="langs"><option value="vi"></option><option value="en"></option><option value="ja"></option><option value="ko"></option><option value="zh"></option><option value="fr"></option><option value="es"></option><option value="de"></option><option value="Vietnamese"></option><option value="English"></option></datalist></div>
        </div>
        <div class="field"><label>Giọng</label>
          <div class="voice-box"><div class="vn"><b id="voiceName"></b><small id="voiceId"></small></div><button class="btn sm" type="button" id="btnVoices">Chọn giọng…</button></div>
          <input type="text" data-k="options.voice.voiceId" placeholder="hoặc dán voice ID (ElevenLabs / MiniMax / CapCut)" />
        </div>
        <div class="row">
          <div class="field"><label>Tốc độ đọc</label><div class="rng"><input type="range" min="0.7" max="1.2" step="0.05" data-k="options.voice.speed" data-type="number" /><output></output></div></div>
          <div class="field" data-el><label>Độ ổn định</label><div class="rng"><input type="range" min="0" max="1" step="0.05" data-k="options.voice.stability" data-type="number" /><output></output></div></div>
          <div class="field" data-el><label>Giống giọng gốc</label><div class="rng"><input type="range" min="0" max="1" step="0.05" data-k="options.voice.similarityBoost" data-type="number" /><output></output></div></div>
        </div>
        <div class="field"><label>Tên dự án (tuỳ chọn)</label><input type="text" id="title" maxlength="120" placeholder="để trống sẽ lấy theo đầu kịch bản" /></div>
        <div class="field"><label>Kịch bản</label><textarea id="script" placeholder="Dán kịch bản vào đây. Mỗi câu kết thúc bằng dấu chấm sẽ thành một dòng phụ đề."></textarea>
          <div class="counter"><span id="chars"></span><span id="est"></span></div>
          <div class="imgneed" id="imgNeed" hidden></div></div>
        <div class="sp">
          <div class="sprow"><button class="btn sm" type="button" id="btnPrompts">📝 Tạo prompt ảnh cho từng cảnh</button>
            <select id="spTool" title="Công cụ bạn dùng để tạo ảnh"><option value="gemini">cho Gemini</option><option value="chatgpt">cho ChatGPT</option><option value="midjourney">cho Midjourney</option><option value="generic">công cụ khác</option></select>
            <button class="btn sm danger" type="button" id="btnPromptsStop" hidden>⏹ Dừng</button></div>
          <div class="spstyles" id="spStyles"></div>
          <p class="hint" id="spStatus">Nhập phong cách ảnh trước (1 phong cách bắt buộc, thêm tối đa 3 nếu kịch bản có nhiều phần khác nhau như hiện tại / hồi tưởng), rồi bấm tạo: AI chia kịch bản thành các cảnh ~15 giây (giống “🎬 Tự động xếp ảnh theo kịch bản bằng AI”), chọn phong cách hợp nhất cho từng cảnh và viết prompt tiếng Anh theo đúng phong cách đó, kèm mô tả nhân vật chung để ảnh đồng nhất. Đặt tên ảnh theo gợi ý <code>scene-01_…</code> rồi tải lên, bấm “📋 Tự xếp” là ảnh vào đúng cảnh.</p>
          <div id="spList"></div>
        </div>
      </section>

      <section class="card"><h2><span class="num">3</span>Hình ảnh (asset)</h2>
        <div class="drop" id="drop"><b>Kéo thả ảnh vào đây</b>, bấm để chọn, hoặc dán (Cmd+V)<br><small>PNG · JPG · WEBP · GIF (lấy khung đầu) · tối đa 80MB mỗi ảnh. Kéo để đổi thứ tự.</small></div>
        <input type="file" id="fileImg" accept="image/*" multiple hidden />
        <div class="thumbs" id="thumbs"></div>
        <p class="hint" id="imgHint"></p>
        <div class="fxbar" id="fxbar"><button class="btn sm" type="button" id="btnStory" title="AI đọc kịch bản rồi chọn ảnh hợp nhất cho từng đoạn, ảnh không khớp sẽ không dùng">🎬 Tự động xếp ảnh theo kịch bản bằng AI</button><button class="btn sm ghost" type="button" id="btnStoryManual" title="Tự gán ảnh cho từng đoạn kịch bản, không dùng AI">📋 Tự xếp</button><button class="btn sm" type="button" id="btnAiFx">🪄 Gợi ý hiệu ứng bằng AI</button><button class="btn sm danger" type="button" id="btnAiStop" hidden>⏹ Dừng</button><span class="hint" id="aiFxStatus"></span><button class="btn sm danger" type="button" id="btnDelAll" hidden title="Bỏ toàn bộ ảnh khỏi dự án">🗑 Xoá tất cả ảnh</button></div>
        <div id="storyBox"></div>
      </section>

      <section class="card"><h2><span class="num">4</span>Khung hình &amp; chuyển cảnh</h2>
        <div class="field"><span class="lbl">Cách đặt ảnh vào khung</span>${seg('options.fit', [['blur', 'Trọn ảnh + nền mờ', 'không cắt ảnh'], ['cover', 'Phủ kín khung', 'có cắt bớt'], ['color', 'Nền màu', 'hợp ảnh nền trong suốt']])}</div>
        <div class="field" id="colorRow"><span class="lbl">Màu nền</span><div class="inline"><input type="color" data-k="options.bgColor" /><small>dùng khi chọn “Nền màu”</small></div></div>
        <div class="row">
          <div class="field"><span class="lbl">Chuyển cảnh</span>${seg('options.transition', [['none', 'Cắt thẳng'], ['fade', 'Mờ nhẹ']])}</div>
          <div class="field"><label>Thời lượng tối đa mỗi cảnh (giây)</label><div class="rng"><input type="range" min="3" max="20" step="1" data-k="options.maxScene" data-type="number" /><output></output></div></div>
        </div>
        <p class="hint">Ảnh đứng yên, không zoom / lia. Ảnh đổi đúng chỗ ngắt câu; “thời lượng tối đa mỗi cảnh” dùng để tính số ảnh nên có (mục 2).</p>
      </section>

      <section class="card"><h2><span class="num">5</span>Phụ đề</h2>
        <label class="check"><span class="switch"><input type="checkbox" data-k="options.captions.on" data-type="bool" /><span></span></span> Đốt phụ đề vào video</label>
        <div id="capOpts">
          <div class="row">
            <div class="field"><span class="lbl">Kiểu</span>${seg('options.captions.preset', [['classic', 'Cổ điển', 'trắng viền đen'], ['bold', 'Vàng đậm', 'kiểu TikTok'], ['box', 'Hộp nền']])}</div>
            <div class="field"><span class="lbl">Vị trí</span>${seg('options.captions.position', [['bottom', 'Dưới'], ['middle', 'Giữa'], ['top', 'Trên']])}</div>
          </div>
          <div class="row">
            <div class="field"><label>Cỡ chữ</label><div class="rng"><input type="range" min="0.6" max="2" step="0.1" data-k="options.captions.sizeMul" data-type="number" /><output></output></div></div>
            <div class="field"><label>Số ký tự tối đa mỗi dòng phụ đề</label><input type="number" min="20" max="120" data-k="options.captions.maxChars" data-type="number" /></div>
          </div>
          <div class="field"><label class="check"><input type="checkbox" data-k="options.captions.uppercase" data-type="bool" /> CHỮ IN HOA</label></div>
        </div>
      </section>

      <section class="card"><h2><span class="num">6</span>Nhạc nền &amp; âm thanh <small>(tuỳ chọn)</small></h2>
        <div class="row">
          <div class="field"><label>File nhạc nền (mp3, m4a, wav…)</label>
            <div class="inline"><input type="file" id="fileBgm" accept="audio/*" /><button class="btn sm ghost" id="btnBgmDel" type="button" hidden>Bỏ nhạc</button></div></div>
          <div class="field"><label>Âm lượng nhạc nền</label><div class="rng"><input type="range" min="0" max="0.6" step="0.01" data-k="options.music.volume" data-type="number" /><output></output></div></div>
        </div>
        <div class="row">
          <div class="field"><label class="check"><input type="checkbox" data-k="options.normalizeAudio" data-type="bool" /> Chuẩn hoá âm lượng giọng đọc (-16 LUFS)</label></div>
          <div class="field"><label>Khoảng lặng cuối video (giây)</label><input type="number" min="0" max="5" step="0.1" data-k="options.tail" data-type="number" /></div>
        </div>
      </section>

      <div id="result"></div>

      <div class="actionbar"><div class="in">
        <div class="sum" id="sum"></div>
        <div class="mini" id="miniProg" hidden></div>
        <button class="btn" id="btnVoice" type="button">🎙 Tạo voice + SRT</button>
        <button class="btn primary" id="btnVideo" type="button">🎬 Tạo video</button>
      </div></div>`;

    bindForm(app);
    $('#title').value = form.title;
    $('#script').value = form.script;
    $('#title').addEventListener('input', (e) => ((form.title = e.target.value), saveForm()));
    let wasStale = storyStale();
    let wasSpStale = spStale();
    $('#script').addEventListener('input', (e) => {
      form.script = e.target.value;
      saveForm();
      syncUI();
      // kịch bản vừa đổi khác (hoặc quay về) bản đã xếp -> cập nhật cảnh báo + nhãn "không dùng"
      if (storyStale() !== wasStale) {
        wasStale = storyStale();
        drawStory();
        drawThumbs();
      }
      if (spStale() !== wasSpStale) {
        wasSpStale = spStale();
        drawPrompts();
      }
    });

    // ảnh
    const drop = $('#drop');
    const fileImg = $('#fileImg');
    drop.addEventListener('click', () => fileImg.click());
    fileImg.addEventListener('change', () => {
      addFiles(fileImg.files);
      fileImg.value = '';
    });
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add('over'))));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.remove('over'))));
    drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

    // nhạc nền
    $('#fileBgm').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) bgm = { file: null, blob: f, name: f.name };
      syncUI();
    });
    $('#btnBgmDel').addEventListener('click', () => {
      bgm = null;
      $('#fileBgm').value = '';
      syncUI();
    });

    $('#btnAiFx').addEventListener('click', () => {
      if (!aiReady()) return toast('Chưa cài AI gợi ý hiệu ứng — vào Cài đặt để nhập API key và chọn model.', 'err');
      const todo = images.filter((im) => !im.fx?.ai && !im.aiBusy && !im.aiQueued);
      if (!todo.length) return toast('Ảnh nào cũng đã có gợi ý. Bấm vào một ảnh để gợi ý lại riêng ảnh đó.');
      suggestFx(todo);
    });
    $('#btnStory').addEventListener('click', arrangeStory);
    $('#btnPrompts').addEventListener('click', genPrompts);
    $('#btnPromptsStop').addEventListener('click', () => spRun?.abort());
    const sp0 = form.scenePrompts;
    if (sp0) {
      $('#spTool').value = sp0.tool || 'gemini';
    }
    drawStyles(sp0?.userStyles?.length ? sp0.userStyles : [{ text: sp0?.userStyle || '', when: '' }]);
    drawPrompts();
    $('#btnStoryManual').addEventListener('click', manualStory);
    $('#btnDelAll').addEventListener('click', () => {
      if (!images.length) return;
      if (!confirm(`Xoá tất cả ${images.length} ảnh? Hiệu ứng và bảng xếp ảnh theo kịch bản cũng bị bỏ. Ảnh đã lưu trên máy sẽ bị xoá khi bạn bấm Tạo voice / Tạo video.`)) return;
      stopSuggest();
      images.forEach((im) => im.url?.startsWith('blob:') && URL.revokeObjectURL(im.url));
      images = [];
      story = null;
      $('#aiFxStatus').textContent = '';
      drawThumbs();
      drawStory();
      syncUI();
      toast('Đã xoá tất cả ảnh', 'ok');
    });
    $('#btnAiStop').addEventListener('click', stopSuggest);
    drawAiBar();
    drawStory();
    $('#btnVoices').addEventListener('click', () =>
      openVoiceModal({
        current: form.options.voice,
        onPick: (v) => {
          const vo = form.options.voice;
          if (vo.provider !== v.provider) {
            vo.provider = v.provider;
            applyProviderDefaults();
          }
          vo.voiceId = v.voiceId;
          vo.voiceName = v.name;
          saveForm();
          refreshInputs();
          syncUI();
          syncModels();
        },
      }),
    );
    $('#modelSel').addEventListener('change', () => {
      const m = modelCache[form.options.voice.provider];
      m?.then((list) => ($('#modelDesc').textContent = list.find((x) => x.id === form.options.voice.modelId)?.description || '')).catch(() => {});
      drawCounter();
    });
    $('#btnVoice').addEventListener('click', () => submit('voice'));
    $('#btnVideo').addEventListener('click', () => submit('video'));
    $('#btnNew').addEventListener('click', newProject);

    drawThumbs();
    syncUI();
    syncModels();
    refreshCredits();
    renderResult(true);
    if (project && ['queued', 'running'].includes(project.status)) startPolling();
  }

  function bindForm(root) {
    $$('[data-k]', root).forEach((el) => {
      const k = el.dataset.k;
      if (el.dataset.v !== undefined) {
        el.addEventListener('click', () => {
          const raw = el.dataset.v;
          setp(form, k, isNaN(raw) ? raw : Number(raw));
          if (k === 'options.voice.provider') applyProviderDefaults();
          saveForm();
          syncUI();
        });
        return;
      }
      const val = getp(form, k);
      if (el.type === 'checkbox') el.checked = !!val;
      else el.value = val ?? '';
      const ev = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(ev, () => {
        let v = el.type === 'checkbox' ? el.checked : el.value;
        if (el.dataset.type === 'number') v = Number(v);
        setp(form, k, v);
        if (k === 'options.voice.provider') {
          applyProviderDefaults();
          refreshInputs(root);
          syncModels();
        }
        saveForm();
        syncUI();
      });
    });
  }

  function refreshInputs(root = document) {
    $$('[data-k]', root).forEach((e2) => {
      if (e2.dataset.v === undefined && e2.type !== 'checkbox' && e2.tagName !== 'SELECT') e2.value = getp(form, e2.dataset.k) ?? '';
      else if (e2.tagName === 'SELECT' && e2.id !== 'modelSel') e2.value = getp(form, e2.dataset.k) ?? '';
    });
  }

  // ----- gợi ý cần bao nhiêu ảnh cho kịch bản -----
  let blockCount = { script: null, n: 0 }; // số đoạn kịch bản (~15 giây/đoạn), lấy từ server
  let blockT = null;
  function drawImgNeed() {
    const box = $('#imgNeed');
    if (!box) return;
    const text = form.script.trim();
    if (!text) return (box.hidden = true);
    const o = form.options;
    // đã có giọng đọc thật của đúng kịch bản này thì dùng độ dài thật, không thì ước tính
    const real = project?.files?.audio && (project.script || '').trim() === text ? project.audioDuration : 0;
    const D = real || text.length / 14 / (o.voice.speed || 1);
    if (blockCount.script !== text) {
      clearTimeout(blockT);
      blockT = setTimeout(async () => {
        try {
          const { blocks } = await api('POST', '/api/story/blocks', { script: text });
          blockCount = { script: text, n: blocks.length };
        } catch (_) {}
        drawImgNeed();
      }, 500);
    }
    const ideal = Math.max(1, Math.ceil(D / o.maxScene));
    const min = blockCount.script === text ? Math.min(blockCount.n, ideal) : null;
    const have = images.length;
    const per = min ? Math.round(D / min) : 0;
    const lines = [];
    if (min && min < ideal) {
      lines.push(`<li><b>Đủ dùng: ~${min} ảnh</b> — mỗi đoạn kịch bản (~${per} giây) một ảnh, khớp với “🎬 Tự động xếp ảnh theo kịch bản bằng AI”.</li>`);
      lines.push(`<li><b>Sinh động nhất: ~${ideal} ảnh</b> — mỗi cảnh ${o.maxScene} giây là một ảnh khác nhau (chỉnh ở “Thời lượng tối đa mỗi cảnh”, mục 4).</li>`);
    } else lines.push(`<li><b>Nên có ~${ideal} ảnh</b> — mỗi cảnh ${o.maxScene} giây một ảnh (chỉnh ở “Thời lượng tối đa mỗi cảnh”, mục 4).</li>`);
    const target = min || ideal;
    const status = !have
      ? `Chưa có ảnh nào — tải ảnh ở mục 3.`
      : have >= ideal
        ? `✓ Bạn đang có ${have} ảnh — đủ cho mọi cảnh.`
        : have >= target
          ? `✓ Bạn đang có ${have} ảnh — đủ dùng${ideal > have ? `; thêm ~${ideal - have} ảnh nữa thì không cảnh nào phải dùng lại ảnh` : ''}.`
          : `Bạn đang có ${have} ảnh → cần thêm khoảng <b>${target - have}</b> ảnh. Ít hơn vẫn dựng được, nhưng mỗi ảnh sẽ hiện lâu hơn (~${Math.round(D / have)} giây).`;
    box.hidden = false;
    box.innerHTML = `<div class="ih">🖼 <b>Cần khoảng bao nhiêu ảnh?</b> <small>Giọng đọc ${real ? '' : '≈ '}${fmtDur(D)} phút${real ? '' : ' (ước tính)'}</small></div><ul>${lines.join('')}</ul><div class="${have && have < target ? 'warn' : 'ok'}">${status}</div>`;
  }

  // ----- credit: số dư API key + ước tính chi phí kịch bản -----
  let credits = null;
  let creditsErr = '';
  let creditsReq = null; // gộp các lần gọi trùng nhau
  async function refreshCredits() {
    if (!settings?.apiKeySet) {
      credits = null;
      creditsErr = '';
      drawSide();
      return drawCounter();
    }
    creditsReq ??= api('GET', '/api/credits')
      .then((r) => {
        credits = r.credits ?? null;
        creditsErr = r.credits == null ? 'genmax không trả về số credit' : '';
      })
      .catch((e) => {
        credits = null;
        creditsErr = e.message;
      })
      .finally(() => (creditsReq = null));
    await creditsReq;
    drawSide();
    drawCounter();
  }

  function drawCounter() {
    const ch = $('#chars');
    if (!ch) return;
    const n = form.script.trim().length;
    const vo = form.options.voice;
    const model = (modelLists[vo.provider] || []).find((m) => m.id === vo.modelId);
    // genmax tính ký tự × hệ số model, xuất SRT cộng thêm 15%
    const cost = Math.ceil(n * (model?.creditRatio ?? 1) * (settings?.exportTranscript ? 1.15 : 1));
    const fmt = (x) => x.toLocaleString('vi-VN');
    let cr = '';
    if (credits != null) cr = ` · <span class="cr ${cost > credits ? 'low' : ''}" title="Credit ước tính cho kịch bản này / credit còn lại của API key">${fmt(cost)}/${fmt(credits)} credit</span>`;
    else if (n && settings?.apiKeySet) cr = ` · <span class="cr" title="Credit ước tính cho kịch bản này">≈ ${fmt(cost)} credit</span>`;
    ch.innerHTML = `${fmt(n)} ký tự${cr}`;
  }

  // ----- model: tải từ genmax theo nhà cung cấp -----
  const modelCache = {};
  const modelLists = {};
  function loadModels(provider) {
    if (!settings?.apiKeySet) return Promise.resolve(null);
    modelCache[provider] ??= api('GET', '/api/models?provider=' + provider).then((l) => (modelLists[provider] = l)).catch((e) => {
      delete modelCache[provider];
      throw e;
    });
    return modelCache[provider];
  }
  const modelLabel = (m) => m.name + (m.badge ? ` · ${m.badge}` : '') + (m.creditRatio != null && m.creditRatio !== 1 ? ` · ×${m.creditRatio} credit` : '');

  /** Điền dropdown model; trả về model đang chọn (hoặc null nếu chưa tải được). */
  async function fillModelSelect(sel, provider, current) {
    sel.dataset.provider = provider;
    sel.innerHTML = `<option value="${esc(current)}">${esc(current || '—')}</option>`;
    sel.value = current;
    let list = null;
    let err = '';
    try {
      list = await loadModels(provider);
    } catch (e) {
      err = e.message;
    }
    if (sel.dataset.provider !== provider) return null; // đã đổi nhà cung cấp trong lúc chờ
    if (!list?.length) {
      sel.title = err || 'Nhập API key trong Cài đặt để tải danh sách model';
      return null;
    }
    sel.title = '';
    const known = list.some((m) => m.id === current);
    sel.innerHTML = list.map((m) => `<option value="${esc(m.id)}">${esc(modelLabel(m))}</option>`).join('') + (current && !known ? `<option value="${esc(current)}">${esc(current)} (không còn trong danh sách)</option>` : '');
    sel.value = current || list[0].id;
    return { list, model: list.find((m) => m.id === sel.value) || null };
  }

  async function syncModels() {
    const sel = $('#modelSel');
    if (!sel) return;
    const vo = form.options.voice;
    const r = await fillModelSelect(sel, vo.provider, vo.modelId);
    const desc = $('#modelDesc');
    if (!desc || sel.dataset.provider !== vo.provider) return;
    if (r && vo.modelId !== sel.value) {
      vo.modelId = sel.value;
      saveForm();
    }
    desc.textContent = r ? r.model?.description || '' : settings?.apiKeySet ? sel.title : 'Nhập API key trong Cài đặt để tải danh sách model.';
    drawCounter();
  }

  function applyProviderDefaults() {
    const d = PROVIDER_DEFAULTS[form.options.voice.provider];
    if (d) {
      form.options.voice.modelId = d.modelId;
      form.options.voice.languageCode = d.languageCode;
    }
  }

  function syncUI() {
    const o = form.options;
    $$('[data-v]').forEach((el) => el.classList.toggle('on', String(getp(form, el.dataset.k)) === el.dataset.v));
    $$('input[type=range][data-k]').forEach((el) => {
      const out = el.parentElement.querySelector('output');
      if (out) out.textContent = el.dataset.k.includes('strength') ? Math.round(el.value * 100) + '%' : el.dataset.k.includes('maxScene') ? el.value + 's' : el.dataset.k.includes('volume') ? Math.round(el.value * 100) + '%' : Number(el.value).toFixed(2).replace(/\.?0+$/, '');
    });
    const short = Number(o.resolution);
    const long = even((short * 16) / 9);
    const [w, h] = o.orientation === 'portrait' ? [short, long] : [long, short];
    const si = $('#sizeInfo');
    if (si) si.textContent = `Xuất ra ${w}×${h} (${o.orientation === 'portrait' ? '9:16' : '16:9'}), ${o.fps} fps. 1080p là mức khuyên dùng cho YouTube/TikTok.`;
    $('#colorRow')?.classList.toggle('dim', o.fit !== 'color');
    $('#capOpts')?.classList.toggle('dim', !o.captions.on);
    $$('[data-el]').forEach((e) => (e.style.display = o.voice.provider === 'elevenlabs' ? '' : 'none'));
    const vn = $('#voiceName');
    if (vn) {
      vn.textContent = o.voice.voiceName || (o.voice.voiceId ? 'Giọng tuỳ chọn' : 'Chưa chọn giọng');
      $('#voiceId').textContent = o.voice.voiceId ? `ID: ${o.voice.voiceId}` : 'bấm “Chọn giọng…” hoặc dán voice ID bên dưới';
    }
    const n = form.script.trim().length;
    const ch = $('#chars');
    if (ch) {
      drawCounter();
      $('#est').textContent = n ? `≈ ${fmtDur(n / 14 / (o.voice.speed || 1))} phút giọng đọc (ước tính)` : '';
    }
    drawImgNeed();
    const da = $('#btnDelAll');
    if (da) da.hidden = !images.length;
    const ih = $('#imgHint');
    if (ih) ih.textContent = images.length ? `${images.length} ảnh — thứ tự từ trái sang phải là thứ tự xuất hiện trong video.` : 'Chưa có ảnh. Mỗi kịch bản bạn có thể đưa 1 asset hoặc nhiều ảnh.';
    const bd = $('#btnBgmDel');
    if (bd) bd.hidden = !bgm;
    const bn = $('#fileBgm');
    if (bn && bgm && !bn.files.length) bn.title = bgm.name;
    const sum = $('#sum');
    if (sum) sum.innerHTML = `<b>${o.orientation === 'portrait' ? '9:16' : '16:9'} · ${short}p</b> · ${images.length} ảnh · ${o.captions.on ? 'có phụ đề' : 'không phụ đề'}${bgm ? ' · có nhạc nền' : ''}`;
    banners();
    setBusy(busy);
  }

  function banners() {
    const el = $('#banners');
    if (!el) return;
    const out = [];
    if (settings && !settings.apiKeySet) out.push('Chưa nhập API key genmax.io. <a href="#/settings">Mở Cài đặt</a> để dán key rồi quay lại.');
    if (health && !health.ffmpeg.ok) out.push('Không tìm thấy FFmpeg. Cài bằng <code>brew install ffmpeg</code> rồi khởi động lại app.');
    else if (health && !health.ffmpeg.libass) out.push('FFmpeg này thiếu libass nên không đốt được phụ đề. Cài lại bản đầy đủ: <code>brew reinstall ffmpeg</code>.');
    el.innerHTML = out.map((m) => `<div class="banner">${m}</div>`).join('');
  }

  // ----- ảnh -----
  function addFiles(list) {
    const ok = /\.(jpe?g|png|webp|gif|bmp)$/i;
    let skipped = 0;
    for (const f of list) {
      if (!ok.test(f.name) && !/^image\//.test(f.type)) {
        skipped++;
        continue;
      }
      const name = f.name && ok.test(f.name) ? f.name : `anh-${Date.now()}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
      const im = { key: nextKey++, file: null, blob: f, name, url: URL.createObjectURL(f), fx: null };
      images.push(im);
    }
    if (skipped) toast(`Bỏ qua ${skipped} file không phải ảnh`, 'err');
    drawThumbs();
    syncUI();
  }

  function drawThumbs() {
    const box = $('#thumbs');
    if (!box) return;
    const usedSet = storyUsed();
    box.innerHTML = images
      .map((im, i) => {
        const fx = im.fx?.effects || [];
        const chips = im.aiBusy ? '<span class="fxc busy">🪄 AI đang xem…</span>' : im.aiQueued ? '<span class="fxc add">⏳ Chờ AI</span>' : fx.length ? fx.map((e) => `<span class="fxc" title="${esc(EFFECTS[e]?.label || e)}">${EFFECTS[e]?.icon || e}</span>`).join('') : '<span class="fxc add">＋ Hiệu ứng</span>';
        const unused = usedSet && !usedSet.has(im);
        return `<div class="thumb ${unused ? 'unused' : ''}" draggable="true" data-i="${i}"><img src="${esc(im.url)}" alt="" /><span class="idx">${i + 1}</span>${unused ? '<span class="nouse">không dùng</span>' : ''}<button class="del" type="button" title="Bỏ ảnh">×</button><div class="fxs" title="Bấm để chọn hiệu ứng">${chips}</div><div class="nm">${esc(im.name)}</div></div>`;
      })
      .join('');
    let dragFrom = null;
    $$('.thumb', box).forEach((t) => {
      const i = Number(t.dataset.i);
      $('.del', t).addEventListener('click', (e) => {
        e.stopPropagation();
        images.splice(i, 1);
        drawThumbs();
        drawStory();
        syncUI();
      });
      t.addEventListener('click', () => openFxEditor(images[i]));
      t.addEventListener('dragstart', (e) => {
        dragFrom = i;
        t.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'thumb');
      });
      t.addEventListener('dragend', () => t.classList.remove('dragging'));
      t.addEventListener('dragover', (e) => {
        if (dragFrom === null) return;
        e.preventDefault();
        t.classList.add('target');
      });
      t.addEventListener('dragleave', () => t.classList.remove('target'));
      t.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        t.classList.remove('target');
        if (dragFrom === null || dragFrom === i) return;
        const [m] = images.splice(dragFrom, 1);
        images.splice(i, 0, m);
        dragFrom = null;
        drawThumbs();
      });
    });
  }

  document.addEventListener('paste', (e) => {
    if (!$('#thumbs')) return;
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) addFiles(files);
  });

  // ----- hiệu ứng phủ theo từng ảnh + AI gợi ý -----
  let EFFECTS = {};
  const AI_FIELDS = { anthropic: ['anthropicKeySet', 'aiModelAnthropic'], gemini: ['geminiKeySet', 'aiModelGemini'] };
  const aiReady = () => {
    const f = settings && AI_FIELDS[settings.aiProvider];
    return !!f && !!settings[f[0]] && !!settings[f[1]];
  };

  /** Gợi ý cho 1 ảnh. signal: huỷ được (nút Dừng). Lỗi kèm status để phân biệt lỗi cài đặt / lỗi tạm thời. */
  async function aiSuggestOne(im, force, signal) {
    const blob = im.blob || (await fetch(im.url, { signal }).then((r) => r.blob()));
    const res = await fetch('/api/ai/suggest' + (force ? '?force=1' : ''), { method: 'POST', body: blob, signal });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(j.error || 'Lỗi ' + res.status), { status: res.status });
    return j;
  }

  // lượt gợi ý hàng loạt đang chạy (chỉ một lượt một lúc)
  let aiRun = null; // { ac, done, total, label }
  function drawAiBar() {
    const stop = $('#btnAiStop');
    if (!stop) return;
    $('#btnAiFx').hidden = $('#btnStory').hidden = !!aiRun;
    stop.hidden = !aiRun;
    if (aiRun) $('#aiFxStatus').textContent = aiRun.total ? `${aiRun.label} ${aiRun.done}/${aiRun.total} xong` : aiRun.label;
  }

  /**
   * Gợi ý cho nhiều ảnh, 2 ảnh một lúc; bấm Dừng để huỷ phần còn lại. Ảnh lỗi thì giữ nguyên.
   * mode 'fx': điền hiệu ứng AI gợi ý; 'desc': chỉ cần mô tả ảnh (để xếp theo kịch bản), không ghi đè hiệu ứng đã chọn.
   * Trả về true nếu xong hết.
   */
  async function suggestFx(list, { force = false, mode = 'fx', label = 'AI đang xem ảnh…' } = {}) {
    if (aiRun) return toast('AI đang chạy — bấm “Dừng” nếu muốn huỷ.', 'err'), false;
    const run = (aiRun = { ac: new AbortController(), done: 0, total: list.length, label });
    const { signal } = run.ac;
    let fail = '';
    list.forEach((im) => (im.aiQueued = true));
    drawThumbs();
    drawAiBar();
    const queue = [...list];
    const worker = async () => {
      for (let im; !signal.aborted && (im = queue.shift()); ) {
        im.aiQueued = false;
        im.aiBusy = true;
        drawThumbs();
        try {
          const r = await aiSuggestOne(im, force, signal);
          im.desc = r.ai?.desc || im.desc || '';
          if (mode === 'fx' || !im.fx) im.fx = r;
          run.done++;
        } catch (e) {
          if (signal.aborted) break;
          fail ||= e.message;
          // sai key / chưa chọn model / hết tiền: ảnh nào cũng sẽ lỗi như vậy -> dừng luôn
          if (e.status === 400 || e.status === 401 || e.status === 402 || e.status === 403) run.ac.abort();
        } finally {
          im.aiBusy = false;
          drawThumbs();
          drawAiBar();
        }
      }
    };
    await Promise.all([worker(), worker()]);
    list.forEach((im) => (im.aiBusy = im.aiQueued = false));
    aiRun = null;
    drawThumbs();
    drawAiBar();
    const st = $('#aiFxStatus');
    const left = run.total - run.done;
    if (st) st.textContent = run.stopped ? `Đã dừng — xong ${run.done}/${run.total} ảnh, ${left} ảnh chưa xem.` : fail ? `Xong ${run.done}/${run.total} ảnh.` : mode === 'fx' ? `Đã gợi ý cho ${run.total} ảnh — bấm vào ảnh để xem / sửa.` : '';
    if (fail) toast('AI xem ảnh: ' + fail + (left && !run.stopped ? ` (dừng, còn ${left} ảnh chưa xem)` : ''), 'err');
    return !run.stopped && !fail;
  }

  // ----- prompt tạo ảnh cho từng cảnh -----
  // form.scenePrompts: { script, tool, aspect, userStyles: [{ text, when }], count, styles: [{ label, desc, use }], characters, texts: [đoạn], scenes: [{ n, style, title, prompt, file }], model }
  // (dữ liệu cũ: userStyle / style là một chuỗi)
  let spRun = null; // AbortController khi đang viết
  const spStale = () => !!form.scenePrompts && form.scenePrompts.script.trim() !== form.script.trim();
  const spStyles = (sp) => (sp?.styles?.length ? sp.styles : sp?.style ? [{ label: sp.userStyle || '', desc: sp.style, use: '' }] : []);
  const MAX_STYLES = 3;

  /** Ô nhập phong cách: 1 bắt buộc, thêm tối đa 3. */
  function drawStyles(list) {
    const box = $('#spStyles');
    const rows = (list && list.length ? list : [{ text: '', when: '' }]).slice(0, MAX_STYLES);
    box.innerHTML =
      rows
        .map(
          (x, i) => `<div class="spsty"><span class="stn" title="Phong cách ${i + 1}">${i + 1}</span>
        <input type="text" data-sty="text" maxlength="300" value="${esc(x.text)}" placeholder="${i ? 'Phong cách ' + (i + 1) + ' — vd: tranh vẽ hang động màu đất son' : 'Phong cách ảnh (bắt buộc) — vd: hoạt hình 2D người que, nét đen dày, màu ấm'}" />
        <input type="text" data-sty="when" maxlength="160" value="${esc(x.when)}" placeholder="${i ? 'dùng cho cảnh nào? (tuỳ chọn) — vd: hồi tưởng' : rows.length > 1 ? 'dùng cho cảnh nào? (tuỳ chọn)' : 'dùng cho cảnh nào? (tuỳ chọn, khi có nhiều phong cách)'}" />
        ${i ? `<button class="btn sm ghost" type="button" data-sty-del="${i}" title="Bỏ phong cách này">✕</button>` : '<span class="stx"></span>'}</div>`,
        )
        .join('') + (rows.length < MAX_STYLES ? `<button class="btn sm ghost" type="button" id="spAddStyle">＋ Thêm phong cách (${rows.length}/${MAX_STYLES})</button>` : '');
    $$('[data-sty="text"]', box).forEach((el) => el.addEventListener('input', () => el.value.trim() && el.classList.remove('need')));
    $$('[data-sty-del]', box).forEach((b) =>
      b.addEventListener('click', () => {
        const cur = readStyles(true);
        cur.splice(Number(b.dataset.styDel), 1);
        drawStyles(cur);
      }),
    );
    $('#spAddStyle', box)?.addEventListener('click', () => {
      drawStyles([...readStyles(true), { text: '', when: '' }]);
      $$('[data-sty="text"]', box).pop().focus();
    });
  }
  /** Đọc các phong cách đã nhập; keepEmpty: giữ cả dòng trống (khi vẽ lại). */
  function readStyles(keepEmpty) {
    const out = $$('#spStyles .spsty').map((r) => ({ text: $('[data-sty="text"]', r).value.trim(), when: $('[data-sty="when"]', r).value.trim() }));
    return keepEmpty ? out : out.filter((x) => x.text);
  }

  async function genPrompts() {
    if (spRun) return;
    if (!form.script.trim()) return toast('Hãy dán kịch bản trước.', 'err');
    if (!aiReady()) return toast('Chưa cài AI — vào Cài đặt → AI gợi ý hiệu ứng để nhập API key và chọn model.', 'err');
    const tool = $('#spTool').value;
    const userStyles = readStyles();
    if (!userStyles.length) {
      const first = $('#spStyles [data-sty="text"]');
      first.classList.add('need');
      first.focus();
      return toast('Hãy nhập phong cách ảnh trước — AI sẽ viết mọi prompt theo phong cách này để ảnh đồng nhất.', 'err');
    }
    const styleKey = JSON.stringify(userStyles);
    const aspect = form.options.orientation === 'portrait' ? '9:16' : '16:9';
    let sp = form.scenePrompts;
    // cùng kịch bản + cùng lựa chọn mà chưa xong -> viết tiếp phần còn thiếu
    const resume = sp && !spStale() && sp.tool === tool && JSON.stringify(sp.userStyles || [{ text: sp.userStyle, when: '' }]) === styleKey && sp.aspect === aspect && sp.scenes.filter((x) => x.prompt).length < sp.count;
    if (!resume && sp && !spStale() && sp.scenes.some((x) => x.prompt) && !confirm('Tạo lại toàn bộ prompt? Danh sách hiện tại sẽ bị thay.')) return;
    const ac = (spRun = new AbortController());
    const st = $('#spStatus');
    const busy = (on) => {
      $('#btnPrompts').hidden = on;
      $('#btnPromptsStop').hidden = !on;
    };
    busy(true);
    try {
      if (!resume) {
        st.textContent = `Bước 1 — AI đọc kịch bản, viết ${userStyles.length > 1 ? userStyles.length + ' phong cách' : 'phong cách'} và nhân vật chung…`;
        const res = await fetch('/api/prompts/style', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ script: form.script, styles: userStyles, aspect }), signal: ac.signal });
        const g = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(g.error || 'Lỗi ' + res.status);
        sp = form.scenePrompts = { script: form.script, tool, aspect, userStyles, count: g.count, styles: g.styles, characters: g.characters, texts: g.texts, model: g.model, scenes: [] };
        saveForm();
        drawPrompts();
      }
      const guide = { count: sp.count, styles: spStyles(sp), characters: sp.characters };
      const have = new Set(sp.scenes.filter((x) => x.prompt).map((x) => x.n));
      for (let a = 1; a <= sp.count; a += 20) {
        const z = Math.min(sp.count, a + 19);
        if ([...Array(z - a + 1)].every((_, k) => have.has(a + k))) continue;
        st.textContent = `Bước 2 — AI viết prompt cảnh ${a}–${z} / ${sp.count}…`;
        const res = await fetch('/api/prompts/scenes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ script: sp.script, from: a, to: z, guide, tool, aspect }), signal: ac.signal });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || 'Lỗi ' + res.status);
        const byN = new Map(sp.scenes.map((x) => [x.n, x]));
        for (const x of j.scenes) if (x.prompt) byN.set(x.n, x);
        sp.scenes = [...byN.values()].sort((x, y) => x.n - y.n);
        sp.model = j.model || sp.model;
        saveForm();
        drawPrompts();
      }
      const done = sp.scenes.filter((x) => x.prompt).length;
      st.textContent = done >= sp.count ? `✓ Đã viết prompt cho ${sp.count} cảnh — tạo ảnh rồi đặt tên theo gợi ý để “📋 Tự xếp” gán đúng cảnh.` : `Xong ${done}/${sp.count} cảnh — bấm “📝 Viết tiếp” để làm nốt.`;
      if (done >= sp.count) toast(`Đã viết prompt cho ${sp.count} cảnh`, 'ok');
    } catch (e) {
      const done = form.scenePrompts?.scenes.filter((x) => x.prompt).length || 0;
      if (ac.signal.aborted) st.textContent = `Đã dừng — xong ${done}/${form.scenePrompts?.count || 0} cảnh. Bấm “📝 Viết tiếp” để làm nốt.`;
      else {
        st.textContent = '';
        toast('Tạo prompt: ' + e.message, 'err');
      }
    } finally {
      spRun = null;
      busy(false);
      drawPrompts();
    }
  }

  const spTimes = (sp) => {
    // thời điểm bắt đầu (ước tính) của từng cảnh theo độ dài chữ
    const real = project?.files?.audio && (project.script || '').trim() === sp.script.trim() ? project.audioDuration : 0;
    const D = real || sp.script.trim().length / 14 / (form.options.voice.speed || 1);
    const total = sp.texts.reduce((n, t) => n + t.length + 1, 0) || 1;
    let acc = 0;
    return sp.texts.map((t) => {
      const at = (D * acc) / total;
      acc += t.length + 1;
      return at;
    });
  };

  function promptsText(sp, fmt) {
    const times = spTimes(sp);
    const rows = sp.scenes.filter((x) => x.prompt);
    // .md: chỉ nội dung prompt, mỗi prompt cách nhau một dòng trống
    if (fmt === 'md') return rows.map((x) => x.prompt).join('\n\n') + '\n';
    if (fmt === 'csv') {
      const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      return '\ufeff' + [['Cảnh', 'Bắt đầu', 'Phong cách', 'Tiêu đề', 'Tên file', 'Prompt', 'Kịch bản'].map(q).join(','), ...rows.map((x) => [x.n, fmtDur(times[x.n - 1]), x.style || 1, x.title, x.file, x.prompt, sp.texts[x.n - 1]].map(q).join(','))].join('\r\n');
    }
    const sts = spStyles(sp);
    const multi = sts.length > 1;
    const stName = (x) => (multi ? ` · Phong cách ${x.style || 1}` : '');
    const head = [
      multi ? `PHONG CÁCH (phong cách của từng cảnh đã ghép sẵn vào cuối prompt):\n${sts.map((x, i) => `${i + 1}. ${x.label ? x.label + ' — ' : ''}${x.use ? 'dùng cho: ' + x.use : ''}\n   ${x.desc}`).join('\n')}` : `PHONG CÁCH CHUNG (đã ghép sẵn vào cuối mỗi prompt):\n${sts[0]?.desc || ''}`,
      sp.characters.length ? `NHÂN VẬT:\n${sp.characters.map((c) => `- ${c.name}: ${c.look}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
    return head + '\n\n' + rows.map((x) => `===== Cảnh ${x.n} (~${fmtDur(times[x.n - 1])}${stName(x)}) — ${x.title}\nTên file: ${x.file}\nKịch bản: ${sp.texts[x.n - 1]}\n\nPrompt:\n${x.prompt}`).join('\n\n');
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const copyText = (t, msg) => navigator.clipboard?.writeText(t).then(() => toast(msg, 'ok'), () => toast('Không chép được', 'err'));

  function drawPrompts() {
    const box = $('#spList');
    if (!box) return;
    const sp = form.scenePrompts;
    const btn = $('#btnPrompts');
    const done = sp ? sp.scenes.filter((x) => x.prompt).length : 0;
    if (btn && !spRun) btn.textContent = sp && !spStale() && done < sp.count ? `📝 Viết tiếp prompt (còn ${sp.count - done} cảnh)` : '📝 Tạo prompt ảnh cho từng cảnh';
    if (!sp) return (box.innerHTML = '');
    const times = spTimes(sp);
    const sts = spStyles(sp);
    const base = (form.title || sp.script.slice(0, 40)).replace(/[\\/:*?"<>|\n]+/g, ' ').trim() || 'kich-ban';
    box.innerHTML = `<div class="splist">
      <div class="sh"><b>Prompt ảnh — ${done}/${sp.count} cảnh</b><small>${esc({ gemini: 'Gemini', chatgpt: 'ChatGPT', midjourney: 'Midjourney' }[sp.tool] || 'công cụ khác')} · ${sp.aspect}${sp.model ? ' · ' + esc(sp.model) : ''}</small><span style="flex:1"></span>
        <button class="btn sm" type="button" id="spCopyAll" ${done ? '' : 'disabled'}>Chép tất cả</button><button class="btn sm" type="button" id="spTxt" ${done ? '' : 'disabled'}>⬇ .txt</button><button class="btn sm" type="button" id="spCsv" ${done ? '' : 'disabled'}>⬇ .csv</button><button class="btn sm" type="button" id="spMd" ${done ? '' : 'disabled'} title="Chỉ nội dung prompt, mỗi prompt cách nhau một dòng trống">⬇ .md</button><button class="btn sm ghost" type="button" id="spDel">Xoá</button></div>
      ${spStale() ? '<div class="banner">Kịch bản đã thay đổi sau khi tạo prompt — số cảnh / nội dung có thể không còn khớp. Bấm “📝 Tạo prompt…” để tạo lại.</div>' : ''}
      <details class="spguide"><summary>${sts.length > 1 ? `${sts.length} phong cách` : 'Phong cách chung'} &amp; nhân vật</summary>${sts
        .map((x, i) => `<p>${sts.length > 1 ? `<span class="stn">${i + 1}</span> <b>${esc(x.label)}</b>${x.use ? ` <small>— dùng cho: ${esc(x.use)} · ${sp.scenes.filter((y) => (y.style || 1) === i + 1 && y.prompt).length} cảnh</small>` : ''}<br>` : ''}${esc(x.desc)}</p>`)
        .join('')}${sp.characters.length ? `<ul>${sp.characters.map((c) => `<li><b>${esc(c.name)}</b>: ${esc(c.look)}</li>`).join('')}</ul>` : ''}</details>
      <div class="sprows">${sp.texts
        .map((t, i) => {
          const x = sp.scenes.find((y) => y.n === i + 1);
          return `<div class="spr"><div class="spm"><b>${i + 1}</b><small>~${fmtDur(times[i])}</small></div><div class="spc">
            <div class="spt">${x && sts.length > 1 ? `<span class="stn" title="${esc(sts[(x.style || 1) - 1]?.label || '')}">PC ${x.style || 1}</span> ` : ''}${esc(x?.title || '')}${x ? ` <code>${esc(x.file)}</code>` : ''}</div>
            <p class="spx">${esc(t)}</p>
            ${x?.prompt ? `<div class="spp"><textarea readonly rows="3">${esc(x.prompt)}</textarea><button class="btn sm" type="button" data-spc="${i + 1}">Chép</button></div>` : '<small class="spwait">chưa có prompt</small>'}
          </div></div>`;
        })
        .join('')}</div></div>`;
    $('#spDel').addEventListener('click', () => {
      if (!confirm('Xoá danh sách prompt?')) return;
      form.scenePrompts = null;
      saveForm();
      drawPrompts();
      $('#spStatus').textContent = '';
    });
    $('#spCopyAll').addEventListener('click', () => copyText(promptsText(sp, 'txt'), 'Đã chép toàn bộ prompt'));
    $('#spTxt').addEventListener('click', () => download(`${base} - prompt anh.txt`, promptsText(sp, 'txt'), 'text/plain;charset=utf-8'));
    $('#spCsv').addEventListener('click', () => download(`${base} - prompt anh.csv`, promptsText(sp, 'csv'), 'text/csv;charset=utf-8'));
    $('#spMd').addEventListener('click', () => download(`${base} - prompt anh.md`, promptsText(sp, 'md'), 'text/markdown;charset=utf-8'));
    $$('[data-spc]', box).forEach((b) => b.addEventListener('click', () => copyText(sp.scenes.find((y) => y.n === Number(b.dataset.spc)).prompt, `Đã chép prompt cảnh ${b.dataset.spc}`)));
  }

  // ----- xếp ảnh theo kịch bản -----
  // story: { blocks: [đoạn], assign: [ảnh | null cho từng đoạn], script: kịch bản lúc xếp, notes, weak: [chỉ số đoạn], model }
  let story = null;
  const storyStale = () => !!story && story.script.trim() !== form.script.trim();
  const storyUsed = () => (story && !storyStale() ? new Set(story.assign.filter((im) => im && images.includes(im))) : null);

  async function arrangeStory() {
    if (!form.script.trim()) return toast('Hãy dán kịch bản trước (mục 2).', 'err');
    if (!images.length) return toast('Hãy tải ảnh lên trước.', 'err');
    if (!aiReady()) return toast('Chưa cài AI — vào Cài đặt → AI gợi ý hiệu ứng để nhập API key và chọn model. Hoặc bấm “📋 Tự xếp” để gán ảnh thủ công.', 'err');
    if (aiRun) return toast('AI đang chạy — bấm “Dừng” nếu muốn huỷ.', 'err');
    // bước 1: AI xem những ảnh chưa có mô tả
    const need = images.filter((im) => !im.desc);
    if (need.length && !(await suggestFx(need, { mode: 'desc', label: 'Bước 1/2 — AI xem ảnh:' }))) return;
    // bước 2: AI ghép ảnh với từng đoạn kịch bản
    const run = (aiRun = { ac: new AbortController(), done: 0, total: 0, label: `Bước 2/2 — AI đang ghép ${images.length} ảnh với kịch bản…` });
    drawAiBar();
    const list = [...images];
    const script = form.script;
    try {
      const res = await fetch('/api/ai/storyboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script, images: list.map((im) => ({ name: im.name, desc: im.desc || '' })) }),
        signal: run.ac.signal,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'Lỗi ' + res.status);
      story = { blocks: j.blocks, assign: j.assign.map((i) => list[i] || null), script, notes: j.notes, weak: j.weak || [], model: j.model };
      aiRun = null;
      drawAiBar();
      const used = storyUsed().size;
      $('#aiFxStatus').textContent = `Đã xếp: ${j.blocks.length} đoạn, dùng ${used}/${list.length} ảnh.`;
      toast(`Đã xếp ảnh theo kịch bản — ${list.length - used} ảnh không dùng. Xem bảng bên dưới để duyệt.`, 'ok');
      drawThumbs();
      drawStory();
      $('#storyBox')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      aiRun = null;
      drawAiBar();
      if (run.ac.signal.aborted) $('#aiFxStatus').textContent = 'Đã dừng xếp ảnh.';
      else {
        $('#aiFxStatus').textContent = '';
        toast('Xếp ảnh theo kịch bản: ' + e.message, 'err');
      }
    }
  }

  /** Tạo bảng thủ công: chia đều ảnh theo thứ tự hiện tại (giống cách dựng mặc định), rồi sửa từng đoạn. */
  async function manualStory() {
    if (!form.script.trim()) return toast('Hãy dán kịch bản trước (mục 2).', 'err');
    if (!images.length) return toast('Hãy tải ảnh lên trước.', 'err');
    if (story && !storyStale() && !confirm('Tạo lại bảng thủ công sẽ thay bảng đang có. Tiếp tục?')) return;
    try {
      const { blocks } = await api('POST', '/api/story/blocks', { script: form.script });
      if (!blocks.length) return toast('Kịch bản chưa có câu nào.', 'err');
      // ảnh đặt tên theo prompt gợi ý (scene-07_…) -> gán đúng số cảnh; không thì chia đều theo thứ tự
      const byNum = new Map();
      for (const im of images) {
        const m = /scene[-_ ]?0*(\d+)/i.exec(im.name || '');
        if (m && !byNum.has(Number(m[1]))) byNum.set(Number(m[1]), im);
      }
      let assign;
      let note = '';
      if (byNum.size && byNum.size >= images.length / 2) {
        let last = null;
        assign = blocks.map((_, i) => (last = byNum.get(i + 1) || last));
        const first = assign.find(Boolean);
        assign = assign.map((im) => im || first);
        const missing = blocks.map((_, i) => i + 1).filter((k) => !byNum.has(k));
        note = `Gán theo số cảnh trong tên file (scene-NN).${missing.length ? ` Thiếu ảnh cho ${missing.length} cảnh (${missing.slice(0, 12).join(', ')}${missing.length > 12 ? '…' : ''}) — dùng ảnh của cảnh trước.` : ' Đủ ảnh cho mọi cảnh.'}`;
      } else {
        const n = Math.min(images.length, blocks.length);
        assign = blocks.map((_, i) => images[Math.floor((i * n) / blocks.length)]);
      }
      story = { blocks, assign, script: form.script, notes: note, weak: [], model: note ? 'Tự xếp' : '' };
      drawThumbs();
      drawStory();
      $('#storyBox')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function drawStory() {
    const box = $('#storyBox');
    if (!box) return;
    if (!story) return (box.innerHTML = '');
    const stale = storyStale();
    const used = storyUsed();
    const idx = (im) => images.indexOf(im) + 1;
    box.innerHTML = `<div class="story">
      <div class="sh"><b>Kịch bản ↔ ảnh</b><small>${story.blocks.length} đoạn${used ? ` · dùng ${used.size}/${images.length} ảnh` : ''}</small><span style="flex:1"></span>
        <button class="btn sm ghost" type="button" id="stOff">Bỏ bảng (chia đều như cũ)</button></div>
      ${stale ? '<div class="banner">Kịch bản đã thay đổi sau khi xếp. Bấm “🎬 Tự động xếp ảnh theo kịch bản bằng AI” (hoặc “📋 Tự xếp”) để xếp lại — nếu không, video sẽ chia đều ảnh như cũ.</div>' : ''}
      ${story.notes ? `<p class="hint ai">🪄 ${esc(story.model)}: ${esc(story.notes)}</p>` : ''}
      <p class="hint">Bấm vào ảnh của một đoạn để đổi ảnh. Ảnh không được gán đoạn nào sẽ không xuất hiện trong video (có nhãn “không dùng” ở danh sách ảnh).</p>
      <div class="srows">${story.blocks
        .map((t, i) => {
          const im = story.assign[i] && images.includes(story.assign[i]) ? story.assign[i] : null;
          const same = i > 0 && story.assign[i - 1] === story.assign[i];
          return `<div class="srow ${story.weak.includes(i) ? 'weak' : ''} ${same ? 'same' : ''}"><span class="sn">${i + 1}</span>
            <button type="button" class="sthumb" data-si="${i}" title="Đổi ảnh cho đoạn ${i + 1}">${im ? `<img src="${esc(im.url)}" alt="" /><i>${idx(im)}</i>` : '<em>chưa có ảnh<br>(dùng ảnh đoạn trước)</em>'}</button>
            <p>${esc(t)}${story.weak.includes(i) ? '<small class="wk">AI: chưa có ảnh khớp tốt</small>' : ''}</p></div>`;
        })
        .join('')}</div></div>`;
    $('#stOff').addEventListener('click', () => {
      if (!confirm('Bỏ bảng xếp ảnh? Video sẽ chia đều ảnh theo thứ tự như trước.')) return;
      story = null;
      drawStory();
      drawThumbs();
    });
    $$('[data-si]', box).forEach((b) => b.addEventListener('click', () => pickStoryImage(Number(b.dataset.si))));
  }

  function pickStoryImage(i) {
    const m = $('#modal');
    m.hidden = false;
    const cur = story.assign[i];
    const close = () => {
      m.hidden = true;
      m.innerHTML = '';
      m.onclick = null;
    };
    m.innerHTML = `<div class="dlg pickdlg"><div class="dh"><h3>Chọn ảnh cho đoạn ${i + 1}</h3><button class="vx" id="pkClose" type="button" aria-label="Đóng">×</button></div>
      <div class="db"><p class="ptext">${esc(story.blocks[i])}</p>
      <label class="check"><input type="checkbox" id="pkRun" checked /> Áp dụng cho cả các đoạn liền kề đang dùng cùng ảnh cũ</label>
      <div class="pgrid">${images
        .map((im, k) => `<button type="button" data-pk="${k}" class="${im === cur ? 'on' : ''}" title="${esc(im.desc || im.name)}"><img src="${esc(im.url)}" alt="" /><span>${k + 1}</span><small>${esc(im.desc || im.name)}</small></button>`)
        .join('')}</div></div></div>`;
    $('#pkClose').addEventListener('click', close);
    m.onclick = (e) => e.target === m && close();
    $$('[data-pk]', m).forEach((b) =>
      b.addEventListener('click', () => {
        const im = images[Number(b.dataset.pk)];
        const old = story.assign[i];
        story.assign[i] = im;
        if ($('#pkRun').checked && old) {
          for (let k = i - 1; k >= 0 && story.assign[k] === old; k--) story.assign[k] = im;
          for (let k = i + 1; k < story.assign.length && story.assign[k] === old; k++) story.assign[k] = im;
        }
        story.weak = story.weak.filter((w) => w !== i);
        close();
        drawStory();
        drawThumbs();
      }),
    );
  }
  function stopSuggest() {
    if (!aiRun) return;
    aiRun.stopped = true;
    aiRun.ac.abort();
  }

  function openFxEditor(im) {
    if (!im) return;
    const n = images.indexOf(im) + 1;
    const w = { effects: [...(im.fx?.effects || [])], fire: (im.fx?.fire || []).map((p) => ({ ...p })), ai: im.fx?.ai };
    const m = $('#modal');
    m.hidden = false;
    let busy = null; // AbortController khi đang gợi ý
    const close = () => {
      busy?.abort();
      m.hidden = true;
      m.innerHTML = '';
      m.onclick = null;
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    const draw = () => {
      const fireOn = w.effects.includes('fire');
      m.innerHTML = `<div class="dlg fxdlg"><div class="dh"><h3>Hiệu ứng cho ảnh ${n}</h3><button class="vx" id="fxClose" type="button" aria-label="Đóng">×</button></div>
        <div class="db">
          <div class="fxpick">${Object.entries(EFFECTS)
            .map(([id, e]) => `<button type="button" data-fx="${id}" class="${w.effects.includes(id) ? 'on' : ''}"><i>${e.icon}</i><b>${esc(e.label)}</b><small>${esc(e.hint)}</small></button>`)
            .join('')}</div>
          <div class="fxstage ${fireOn ? 'pick' : ''}" id="fxStage"><img src="${esc(im.url)}" alt="" />${fireOn ? w.fire.map((p, i) => `<span class="pt" data-pt="${i}" style="left:${p.x * 100}%;top:${p.y * 100}%" title="Bấm để xoá">🔥</span>`).join('') : ''}</div>
          <p class="hint">${fireOn ? (w.fire.length ? 'Bấm lên ảnh để thêm vị trí lửa (tối đa 3), bấm vào 🔥 để xoá.' : 'Bấm lên ảnh vào chỗ đống lửa / ngọn đuốc. Chưa đặt thì hiệu ứng nằm giữa phía dưới khung.') : 'Chọn nhiều hiệu ứng cùng lúc được, nên dùng tối đa 2–3.'}</p>
          ${w.ai ? `<p class="hint ai">🪄 ${esc(w.ai.model)}: ${esc(w.ai.reason || '')}</p>` : ''}
          <div class="btns">${busy ? '<button class="btn sm danger" type="button" id="fxAi">⏹ Dừng (AI đang xem ảnh…)</button>' : `<button class="btn sm" type="button" id="fxAi" ${im.aiBusy ? 'disabled title="Ảnh này đang được gợi ý trong lượt chung"' : ''}>🪄 ${w.ai ? 'Gợi ý lại' : 'Gợi ý'} bằng AI</button>`}<span style="flex:1"></span><button class="btn sm ghost" type="button" id="fxClear">Bỏ hết</button><button class="btn sm primary" type="button" id="fxOk">Xong</button></div>
        </div></div>`;
      $('#fxClose').addEventListener('click', close);
      $$('[data-fx]', m).forEach((b) =>
        b.addEventListener('click', () => {
          const id = b.dataset.fx;
          w.effects = w.effects.includes(id) ? w.effects.filter((x) => x !== id) : [...w.effects, id];
          draw();
        }),
      );
      const stage = $('#fxStage');
      stage.addEventListener('click', (e) => {
        if (!fireOn) return;
        const pt = e.target.closest('[data-pt]');
        if (pt) w.fire.splice(Number(pt.dataset.pt), 1);
        else {
          const r = $('img', stage).getBoundingClientRect();
          const x = (e.clientX - r.left) / r.width;
          const y = (e.clientY - r.top) / r.height;
          if (x < 0 || x > 1 || y < 0 || y > 1) return;
          if (w.fire.length >= 3) w.fire.shift();
          w.fire.push({ x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 });
        }
        draw();
      });
      $('#fxClear').addEventListener('click', () => {
        w.effects = [];
        w.fire = [];
        draw();
      });
      $('#fxOk').addEventListener('click', () => {
        im.fx = w.effects.length || w.ai ? { effects: w.effects, fire: w.effects.includes('fire') ? w.fire : [], ai: w.ai } : null;
        close();
        drawThumbs();
      });
      $('#fxAi').addEventListener('click', async () => {
        if (busy) {
          busy.abort();
          return;
        }
        if (!aiReady()) return toast('Chưa cài AI gợi ý hiệu ứng — vào Cài đặt để nhập API key và chọn model.', 'err');
        const ac = (busy = new AbortController());
        draw();
        try {
          const r = await aiSuggestOne(im, !!w.ai, ac.signal);
          Object.assign(w, { effects: r.effects || [], fire: r.fire || [], ai: r.ai });
        } catch (e) {
          if (!ac.signal.aborted) toast(e.message, 'err');
          else if (!m.hidden) toast('Đã dừng gợi ý cho ảnh này.');
        }
        busy = null;
        if (!m.hidden && m.querySelector('.fxdlg')) draw();
      });
    };
    draw();
    m.onclick = (e) => e.target === m && close();
  }

  // ----- gửi lên server -----
  function setBusy(b) {
    busy = b;
    ['btnVoice', 'btnVideo'].forEach((id) => {
      const el = $('#' + id);
      if (el) el.disabled = b || (project && ['queued', 'running'].includes(project.status));
    });
  }

  async function uploadAsset(kind, item, label) {
    const res = await fetch(`/api/projects/${projectId}/assets?kind=${kind}&name=${encodeURIComponent(item.name)}`, { method: 'POST', body: item.blob });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${label}: ${j.error || res.status}`);
    item.file = j.file;
    item.blob = null;
  }

  async function submit(action) {
    if (busy) return;
    const o = form.options;
    if (!form.script.trim()) return toast('Hãy dán kịch bản trước.', 'err');
    if (!o.voice.voiceId.trim()) {
      toast('Chưa chọn giọng đọc.', 'err');
      return $('#voiceName')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (action === 'video' && !images.length) return toast('Hãy tải ít nhất 1 ảnh asset.', 'err');
    setBusy(true);
    try {
      if (!projectId) projectId = (await api('POST', '/api/projects')).id;
      const pending = images.filter((i) => !i.file);
      for (let k = 0; k < pending.length; k++) {
        toast(`Đang tải ảnh ${k + 1}/${pending.length}…`);
        await uploadAsset('image', pending[k], pending[k].name);
      }
      if (bgm && !bgm.file) await uploadAsset('bgm', bgm, 'Nhạc nền');
      const imageFx = Object.fromEntries(images.filter((i) => i.fx).map((i) => [i.file, i.fx]));
      const storyboard = story && !storyStale() ? { assign: story.assign.map((im) => (im && images.includes(im) ? im.file : null)) } : null;
      const data = { title: form.title, script: form.script, options: form.options, images: images.map((i) => i.file), imageFx, storyboard, scenePrompts: form.scenePrompts || null, bgm: bgm ? bgm.file : null };
      project = await api('POST', `/api/projects/${projectId}/run`, { action, data });
      renderResult(true);
      startPolling();
      $('#result')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  function newProject() {
    if (project && ['queued', 'running'].includes(project.status) && !confirm('Dự án đang chạy. Vẫn tạo dự án mới? (dự án cũ vẫn tiếp tục chạy)')) return;
    stopPolling();
    projectId = null;
    project = null;
    images.forEach((i) => i.url?.startsWith('blob:') && URL.revokeObjectURL(i.url));
    images = [];
    story = null;
    bgm = null;
    const keepOpts = form.options;
    form = DEFAULT_FORM();
    form.options = keepOpts;
    renderCreate();
  }

  // ----- kết quả -----
  const STATUS = { idle: 'Chưa chạy', queued: 'Đang chờ', running: 'Đang chạy', done: 'Hoàn tất', error: 'Lỗi', canceled: 'Đã huỷ' };

  function renderResult(rebuild) {
    const root = $('#result');
    if (!root) return;
    if (!project || (project.status === 'idle' && !project.files.audio && !project.files.video && !project.logs.length)) {
      root.innerHTML = '';
      return;
    }
    if (rebuild || !$('#resBar')) {
      root.innerHTML = `
        <section class="card"><h2>Kết quả<button class="btn sm ghost" id="btnReveal" type="button" hidden title="Mở thư mục chứa MP4 / MP3 / SRT — dùng thẳng file gốc, khỏi tải về">📂 Mở trong Finder</button></h2>
          <div class="status-line"><span class="pill" id="resPill"></span><span class="msg" id="resMsg"></span><button class="btn sm danger" id="btnCancel" hidden>Huỷ</button></div>
          <div class="bar"><i id="resBar"></i></div>
          <div class="eta" id="resEta"></div>
          <div class="err" id="resErr" hidden></div>
          <details><summary>Nhật ký chi tiết</summary><div class="logs" id="resLogs"></div></details>
          <div class="result-grid">
            <div class="box"><h3>Voice-over &amp; SRT</h3><div id="voiceArea"><small>Chưa có. Bấm “Tạo voice + SRT”.</small></div></div>
            <div class="box"><h3>Video</h3><div id="videoArea"><small>Chưa có. Bấm “Tạo video”.</small></div></div>
          </div>
        </section>`;
      $('#btnReveal').addEventListener('click', () => reveal(projectId));
      $('#btnCancel').addEventListener('click', async () => {
        try {
          project = await api('POST', `/api/projects/${projectId}/cancel`);
          renderResult();
        } catch (e) {
          toast(e.message, 'err');
        }
      });
    }
    const p = project;
    const active = ['queued', 'running'].includes(p.status);
    const pill = $('#resPill');
    pill.textContent = STATUS[p.status] || p.status;
    pill.className = 'pill ' + p.status;
    $('#resMsg').textContent = p.message || '';
    $('#resBar').style.width = (p.status === 'done' ? 100 : p.progress) + '%';
    const t = timing(p);
    $('#resEta').innerHTML = t.html;
    const mini = $('#miniProg');
    if (mini) {
      mini.hidden = !active;
      $('#sum')?.toggleAttribute('hidden', active); // nhường chỗ cho tiến trình
      mini.innerHTML = active ? `<div class="mbar"><i style="width:${p.progress}%"></i></div><span>${t.short}</span>` : '';
    }
    $('#btnCancel').hidden = !active;
    $('#btnReveal').hidden = !(p.files.audio || p.files.video);
    const er = $('#resErr');
    er.hidden = !p.error;
    er.textContent = p.error || '';
    const lg = $('#resLogs');
    lg.innerHTML = p.logs.map((l) => `<div>${esc(l.t)}  ${esc(l.msg)}</div>`).join('');
    lg.scrollTop = lg.scrollHeight;

    const va = $('#voiceArea');
    if (p.audioUrl) {
      if (va.dataset.src !== p.audioUrl) {
        va.dataset.src = p.audioUrl;
        va.innerHTML = `<audio controls src="${esc(p.audioUrl)}"></audio>
          <small>${p.audioDuration ? fmtDur(p.audioDuration) + ' phút' : ''} · SRT: ${esc(p.srtSource || '')}</small>
          <div class="btns"><a class="btn sm" href="${esc(p.audioUrl)}&download=1">⬇ MP3</a><a class="btn sm" href="${esc(p.srtUrl)}&download=1">⬇ SRT</a></div>
          <details><summary>Xem / chép SRT</summary><textarea class="srt" readonly id="srtText">Đang tải…</textarea><div class="btns"><button class="btn sm" id="btnCopySrt" type="button">Chép SRT</button></div></details>`;
        fetch(p.srtUrl)
          .then((r) => r.text())
          .then((t) => ($('#srtText').value = t))
          .catch(() => {});
        $('#btnCopySrt').addEventListener('click', () => {
          navigator.clipboard?.writeText($('#srtText').value).then(() => toast('Đã chép SRT', 'ok'));
        });
      }
    } else {
      va.dataset.src = '';
      if (!active) va.innerHTML = '<small>Chưa có. Bấm “Tạo voice + SRT”.</small>';
    }
    const vd = $('#videoArea');
    if (p.videoUrl) {
      if (vd.dataset.src !== p.videoUrl) {
        vd.dataset.src = p.videoUrl;
        vd.innerHTML = `<video controls src="${esc(p.videoUrl)}"></video>
          <small>${fmtDur(p.videoDuration)} phút · ${p.options.orientation === 'portrait' ? '9:16' : '16:9'} ${p.options.resolution}p</small>
          <div class="btns"><a class="btn sm primary" href="${esc(p.videoUrl)}&download=1">⬇ Tải MP4</a></div>`;
      }
    } else {
      vd.dataset.src = '';
      if (!active) vd.innerHTML = '<small>Chưa có. Bấm “Tạo video”.</small>';
    }
    setBusy(busy);
  }

  // thời gian chạy / còn lại / hoàn thành của tác vụ
  let etaSmooth = null; // { id, rem, at } để số giây còn lại không nhảy lung tung
  const clock = (ms) => new Date(ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  function timing(p) {
    const pct = p.status === 'done' ? 100 : Number(p.progress) || 0;
    const start = p.startedAt ? Date.parse(p.startedAt) : null;
    if (p.status === 'queued') return { html: 'Đang chờ trong hàng đợi…', short: 'Đang chờ…' };
    if (!start) return { html: '', short: '' };
    const end = p.finishedAt ? Date.parse(p.finishedAt) : Date.now();
    const el = Math.max(0, (end - start) / 1000);
    if (p.status === 'done') return { html: `✓ Hoàn thành lúc <b>${clock(end)}</b> · mất ${fmtDur(el)}`, short: '' };
    if (p.status !== 'running') return { html: `Dừng lúc ${clock(end)} sau ${fmtDur(el)}`, short: '' };
    let rem = null;
    if (pct >= 2 && el >= 4) {
      const raw = (el * (100 - pct)) / pct;
      const now = Date.now();
      if (etaSmooth && etaSmooth.id === p.id + p.startedAt) {
        const projected = Math.max(0, etaSmooth.rem - (now - etaSmooth.at) / 1000);
        rem = projected * 0.7 + raw * 0.3;
      } else rem = raw;
      etaSmooth = { id: p.id + p.startedAt, rem, at: now };
    }
    const left = rem == null ? 'đang ước tính thời gian còn lại…' : `còn khoảng <b>${fmtDur(rem)}</b> · dự kiến xong lúc <b>${clock(Date.now() + rem * 1000)}</b>`;
    return {
      html: `<b>${Math.round(pct)}%</b> · đã chạy ${fmtDur(el)} · ${left}`,
      short: `${Math.round(pct)}%` + (rem == null ? ` · ${fmtDur(el)}` : ` · còn ~${fmtDur(rem)}`),
    };
  }

  async function reveal(id) {
    try {
      await api('POST', `/api/projects/${id}/reveal`);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      if (!projectId) return stopPolling();
      try {
        project = await api('GET', `/api/projects/${projectId}`);
        renderResult();
        if (!['queued', 'running'].includes(project.status)) {
          stopPolling();
          refreshCredits();
          if (project.status === 'done') toast(project.job === 'voice' ? 'Đã tạo voice + SRT' : 'Video đã sẵn sàng!', 'ok');
          if (project.status === 'error') toast('Có lỗi — xem phần Kết quả', 'err');
        }
      } catch (e) {
        stopPolling();
      }
    }, 1000);
  }
  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  // ----- chọn giọng (nhiều nguồn, bộ lọc giống thư viện genmax) -----
  const PROVIDERS = [
    ['elevenlabs', 'ElevenLabs'],
    ['minimax', 'MiniMax'],
    ['capcut', 'CapCut'],
  ];
  const PROV_NAME = Object.fromEntries(PROVIDERS);
  // tab "all" = toàn bộ thư viện, tab "mine" = nguồn thứ hai của nhà cung cấp (nếu có)
  const SOURCES = {
    elevenlabs: { all: 'el-shared', mine: 'el-default', mineLabel: 'Giọng nói mặc định' },
    minimax: { all: 'mm-system', mine: 'mm-cloned', mineLabel: 'Giọng đã clone' },
    capcut: { all: 'cc-system' },
  };
  const ANY = ['', 'Tất cả'];
  const EL_ACCENTS = {
    vi: ['northern', 'southern', 'central', 'standard'],
    en: ['american', 'british', 'australian', 'canadian', 'irish', 'scottish', 'indian', 'african american', 'us southern', 'received pronunciation', 'nigerian', 'south african'],
    es: ['peninsular', 'latin american', 'mexican', 'argentine', 'andalusian', 'colombian'],
    pt: ['brazilian', 'european'],
    fr: ['parisian', 'canadian', 'belgian', 'swiss'],
    de: ['standard', 'bavarian', 'swiss', 'austrian'],
    zh: ['standard', 'taiwan mandarin', 'beijing'],
    ar: ['standard', 'saudi', 'egyptian', 'jordanian', 'gulf'],
    _: ['standard'],
  };
  // bộ lọc của từng nguồn; opts là danh sách [giá trị, nhãn] hoặc hàm trả về danh sách đó
  const VOICE_FILTERS = {
    'el-shared': [
      { k: 'language', label: 'Ngôn ngữ', combo: true, opts: () => [['', 'Tất cả ngôn ngữ'], ...langOpts('elevenlabs')] },
      { k: 'accent', label: 'Giọng', combo: true, opts: (f) => [['', 'Bất kỳ'], ...(EL_ACCENTS[f.language] || EL_ACCENTS._).map((a) => [a, cap(a)])] },
      { k: 'category', label: 'Chất lượng', opts: [ANY, ['high_quality', 'Chất lượng cao']] },
      { k: 'gender', label: 'Giới tính', opts: [ANY, ['male', 'Nam'], ['female', 'Nữ'], ['neutral', 'Trung tính']] },
      { k: 'age', label: 'Độ tuổi', opts: [ANY, ['young', 'Trẻ'], ['middle_aged', 'Trung niên'], ['old', 'Lớn tuổi']] },
      {
        k: 'useCase',
        label: 'Danh mục',
        opts: [ANY, ['narrative_and_story', 'Kể chuyện'], ['informative_and_educational', 'Giáo dục / thông tin'], ['conversational', 'Hội thoại'], ['social_media', 'Mạng xã hội'], ['characters_and_animation', 'Nhân vật / hoạt hình'], ['entertainment_and_tv', 'Giải trí / TV'], ['advertisement', 'Quảng cáo']],
      },
      { k: 'sort', label: 'Sắp xếp', opts: [['trending', 'Thịnh hành'], ['created_date', 'Mới nhất'], ['cloned_by_count', 'Nhiều người dùng'], ['usage_character_count_1y', 'Đọc nhiều nhất (1 năm)']] },
    ],
    'mm-system': [
      { k: 'language', label: 'Ngôn ngữ', combo: true, opts: () => [['', 'Tất cả ngôn ngữ'], ...langOpts('minimax')] },
      { k: 'accent', label: 'Giọng', opts: [ANY, ['Standard', 'Standard'], ['EN-US (General)', 'EN-US'], ['EN-British', 'EN-British'], ['EN-Australian', 'EN-Australian'], ['EN-England', 'EN-England']] },
      { k: 'gender', label: 'Giới tính', opts: [ANY, ['Male', 'Nam'], ['Female', 'Nữ']] },
      { k: 'age', label: 'Độ tuổi', opts: [ANY, ['Child', 'Trẻ em'], ['Young', 'Trẻ'], ['Middle-aged', 'Trung niên'], ['Elderly', 'Lớn tuổi']] },
      {
        k: 'useCase',
        label: 'Danh mục',
        opts: [ANY, ...['Audiobooks & Novels', 'Documentary', 'E-Learning', 'Corporate & Narration', 'Podcasts & Social', 'Commercials & Trailers', 'Audio Drama', 'Anime & Animation', 'Character Dubbing', 'Games & RPG'].map((x) => [x, x])],
      },
    ],
    'cc-system': [
      { k: 'language', label: 'Ngôn ngữ', combo: true, opts: () => [['', 'Tất cả ngôn ngữ'], ...langOpts('capcut')] },
      { k: 'gender', label: 'Giới tính', opts: [ANY, ['Male', 'Nam'], ['Female', 'Nữ'], ['Gender Diversity', 'Khác']] },
      { k: 'age', label: 'Độ tuổi', opts: [ANY, ...['Children', 'Teenager', 'Middle-aged', 'Elderly', 'Baby', 'No Age'].map((x) => [x, x])] },
      { k: 'emotion', label: 'Cảm xúc', opts: [ANY, ...['Plain', 'Excited', 'Pleasure', 'Sad', 'Angery', 'Fear', 'Shy', 'Proud', 'Confused'].map((x) => [x, x === 'Angery' ? 'Angry' : x])] },
      { k: 'accent', label: 'Tông giọng', opts: [ANY, ...['Gentle / Kind', 'Steady', 'Deep', 'Magnetic', 'Cute', 'Mysterious', 'Atmosphere', 'Refreshing/Fierce', 'Technology', 'ASMR', 'Retro'].map((x) => [x, x])] },
    ],
  };
  const cap = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

  // ngôn ngữ của từng nhà cung cấp (tải một lần)
  const langCache = {};
  const langLists = {};
  function loadLangs(provider) {
    langCache[provider] ??= api('GET', '/api/languages?provider=' + provider)
      .then((l) => (langLists[provider] = l))
      .catch(() => {
        delete langCache[provider];
        return [];
      });
    return langCache[provider];
  }
  const langOpts = (provider) => (langLists[provider] || []).map((l) => [l.code, l.name]);

  // cờ: mã ngôn ngữ (hoặc tên tiếng Anh của MiniMax) -> emoji quốc kỳ
  const LANG_CC = {
    en: 'US', vi: 'VN', zh: 'CN', yue: 'HK', ja: 'JP', ko: 'KR', fr: 'FR', de: 'DE', es: 'ES', pt: 'BR', it: 'IT', ru: 'RU', ar: 'SA', hi: 'IN', id: 'ID', th: 'TH', tr: 'TR',
    pl: 'PL', nl: 'NL', sv: 'SE', da: 'DK', fi: 'FI', no: 'NO', nb: 'NO', nn: 'NO', cs: 'CZ', el: 'GR', he: 'IL', hu: 'HU', ro: 'RO', uk: 'UA', ms: 'MY', fil: 'PH', tl: 'PH',
    ta: 'IN', te: 'IN', mr: 'IN', gu: 'IN', kn: 'IN', ml: 'IN', pa: 'IN', as: 'IN', bg: 'BG', hr: 'HR', sk: 'SK', sl: 'SI', fa: 'IR', ca: 'AD', af: 'ZA', hy: 'AM', az: 'AZ',
    be: 'BY', bn: 'BD', bs: 'BA', et: 'EE', lv: 'LV', lt: 'LT', sr: 'RS', mk: 'MK', ka: 'GE', kk: 'KZ', ur: 'PK', ne: 'NP', sw: 'KE', cy: 'GB', ga: 'IE', is: 'IS', gl: 'ES',
    eu: 'ES', lb: 'LU', mt: 'MT', sq: 'AL', mn: 'MN', my: 'MM', km: 'KH', lo: 'LA', si: 'LK', ps: 'AF', uz: 'UZ', ky: 'KG', tg: 'TJ', so: 'SO', ha: 'NG', yo: 'NG', zu: 'ZA',
  };
  const NAME_CODE = { 'chinese (mandarin)': 'zh', chinese: 'zh', cantonese: 'yue', filipino: 'fil', nynorsk: 'nn', norwegian: 'no' };
  function flagOf(lang) {
    let code = String(lang || '').toLowerCase();
    if (!LANG_CC[code]) {
      code = NAME_CODE[code] || (langLists.elevenlabs || []).find((l) => l.name.toLowerCase() === code)?.code || code.slice(0, 2);
    }
    const cc = LANG_CC[code];
    return cc ? String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0))) : '🌐';
  }
  const fmtNum = (n) => (n == null ? '-' : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(n));

  let previewAudio = null;
  /**
   * Mở hộp chọn giọng.
   * current: { provider, voiceId, languageCode } của giọng đang dùng; onPick(voice) khi bấm "Sử dụng".
   */
  async function openVoiceModal({ current, onPick }) {
    let st = {};
    try {
      st = JSON.parse(localStorage.getItem('gva.voicePicker.v1') || '{}') || {};
    } catch (_) {}
    st.provider = PROV_NAME[current.provider] ? current.provider : st.provider || 'elevenlabs';
    st.tab ||= 'all';
    st.filters ||= {};
    if (st.tab === 'mine' && !SOURCES[st.provider].mine) st.tab = 'all';
    const saveSt = () => {
      try {
        localStorage.setItem('gva.voicePicker.v1', JSON.stringify(st));
      } catch (_) {}
    };

    const m = $('#modal');
    const token = (m._owner = {});
    m.hidden = false;
    m.innerHTML = `<div class="dlg vdlg" role="dialog" aria-label="Chọn giọng">
      <div class="vhead"><div class="vtabs" id="vmTabs"></div><div class="vprov" id="vmProv"></div><button class="vx" id="mClose" type="button" aria-label="Đóng">×</button></div>
      <div class="vfilters" id="vmFilters"></div>
      <div class="vsearch"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input type="text" id="vmSearch" placeholder="Tìm theo tên hoặc ID giọng nói..." /></div>
      <div class="vbody" id="vmBody"><div class="vgrid" id="vmGrid"></div><div class="vmore" id="vmMore"></div></div></div>`;

    let favs = [];
    const favKey = (v) => v.provider + ':' + v.voiceId;
    let favSet = new Set();
    let voices = [];
    let page = 0;
    let hasMore = false;
    let loading = false;
    let reqId = 0;
    let playing = '';

    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const open = $$('.combo.open', m);
      if (open.length) open.forEach((c) => c.classList.remove('open'));
      else close();
    };
    const onDocClick = (e) => {
      if (!e.target.closest('.combo')) $$('.combo.open', m).forEach((c) => c.classList.remove('open'));
    };
    const close = () => {
      previewAudio?.pause();
      observer.disconnect();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onDocClick);
      m.hidden = true;
      m.innerHTML = '';
    };
    $('#mClose').addEventListener('click', close);
    m.addEventListener('click', (e) => e.target === m && close());
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onDocClick);

    const source = () => (st.tab === 'fav' ? 'fav' : SOURCES[st.provider][st.tab]);
    const filters = () => {
      const src = source();
      if (!st.filters[src]) {
        // lần đầu: lọc theo ngôn ngữ đang dùng nếu cùng nhà cung cấp
        const f = (st.filters[src] = {});
        if (VOICE_FILTERS[src]?.some((d) => d.k === 'language') && current.provider === st.provider && current.languageCode) f.language = current.languageCode;
        if (src === 'el-shared') f.sort = 'trending';
      }
      return st.filters[src];
    };

    function drawHead() {
      const tabs = [['fav', '♡', 'Yêu thích'], ['all', '▦', 'Tất cả giọng nói']];
      if (SOURCES[st.provider].mine) tabs.push(['mine', '◉', SOURCES[st.provider].mineLabel]);
      $('#vmTabs').innerHTML = tabs.map(([k, i, t]) => `<button type="button" data-tab="${k}" class="${st.tab === k ? 'on' : ''}"><i>${i}</i>${t}</button>`).join('');
      $('#vmProv').innerHTML = PROVIDERS.map(([k, t]) => `<button type="button" data-prov="${k}" class="${st.provider === k ? 'on' : ''}">${t}</button>`).join('');
      $('#vmProv').classList.toggle('dim', st.tab === 'fav');
      $$('[data-tab]', m).forEach((b) =>
        b.addEventListener('click', () => {
          st.tab = b.dataset.tab;
          refresh();
        }),
      );
      $$('[data-prov]', m).forEach((b) =>
        b.addEventListener('click', () => {
          st.provider = b.dataset.prov;
          if (st.tab === 'mine' && !SOURCES[st.provider].mine) st.tab = 'all';
          refresh();
        }),
      );
    }

    function drawFilters() {
      const box = $('#vmFilters');
      const defs = VOICE_FILTERS[source()] || [];
      const f = filters();
      $('#vmSearch').value = f.search || '';
      if (!defs.length) {
        box.innerHTML = '';
        box.hidden = true;
        return;
      }
      box.hidden = false;
      box.innerHTML =
        defs
          .map((d, i) => {
            const opts = typeof d.opts === 'function' ? d.opts(f) : d.opts;
            const val = f[d.k] || '';
            if (!d.combo) return `<div class="vf"><label>${d.label}</label><select data-f="${d.k}">${opts.map(([v, t]) => `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`;
            const curLabel = opts.find(([v]) => v === val)?.[1] || val || opts[0][1];
            const flag = d.k === 'language';
            return `<div class="vf"><label>${d.label}</label><div class="combo" data-combo="${i}">
              <button type="button" class="cbtn">${flag && val ? flagOf(val) + ' ' : ''}${esc(curLabel)}<span>⌄</span></button>
              <div class="cpop"><input type="text" placeholder="Tìm ${d.label.toLowerCase()}..." /><div class="clist">${opts
                .map(([v, t]) => `<button type="button" data-v="${esc(v)}" class="${v === val ? 'on' : ''}">${flag && v ? `<i>${flagOf(v)}</i>` : ''}${esc(t)}</button>`)
                .join('')}</div></div></div></div>`;
          })
          .join('') + `<button type="button" class="btn sm vreload" id="vmReload" title="Tải lại">↻</button>`;
      $$('select[data-f]', box).forEach((sel) =>
        sel.addEventListener('change', () => {
          f[sel.dataset.f] = sel.value;
          reload();
        }),
      );
      $$('[data-combo]', box).forEach((c) => {
        const d = defs[c.dataset.combo];
        const inp = $('input', c);
        $('.cbtn', c).addEventListener('click', () => {
          const open = !c.classList.contains('open');
          $$('.combo.open', box).forEach((x) => x.classList.remove('open'));
          c.classList.toggle('open', open);
          if (open) {
            inp.value = '';
            inp.dispatchEvent(new Event('input'));
            inp.focus();
          }
        });
        inp.addEventListener('input', () => {
          const q = inp.value.trim().toLowerCase();
          $$('.clist button', c).forEach((b) => (b.hidden = !!q && !b.textContent.toLowerCase().includes(q) && !b.dataset.v.toLowerCase().includes(q)));
        });
        $$('.clist button', c).forEach((b) =>
          b.addEventListener('click', () => {
            f[d.k] = b.dataset.v;
            if (d.k === 'language' && source() === 'el-shared') delete f.accent; // giọng vùng phụ thuộc ngôn ngữ
            drawFilters();
            reload();
          }),
        );
      });
      $('#vmReload').addEventListener('click', reload);
    }

    const isSelected = (v) => v.provider === current.provider && v.voiceId === current.voiceId;
    function card(v, i) {
      const flags = v.langs?.length ? v.langs.slice(0, 4).map(flagOf).join('') + (v.langs.length > 4 ? `<small>+${v.langs.length - 4}</small>` : '') : '';
      const stats = v.clones != null || v.usage != null ? `<div class="vstats"><span title="Số người dùng giọng này">👥 ${fmtNum(v.clones)}</span><span title="Số ký tự đã đọc (1 năm)">⚡ ${fmtNum(v.usage)}</span></div>` : '';
      return `<div class="vcard ${isSelected(v) ? 'sel' : ''}">
        <div class="vtop">${v.image ? `<img src="${esc(v.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''}<b title="${esc(v.name)}">${esc(v.name)}</b>${st.tab === 'fav' ? `<span class="vprovtag">${PROV_NAME[v.provider]}</span>` : ''}</div>
        <p>${esc(v.description || '')}</p>
        <div class="vtags">${(v.tags || []).map((t) => `<span>${esc(cap(String(t).replace(/_/g, ' ')))}</span>`).join('')}</div>
        ${stats}
        <div class="vact"><span class="vflags">${flags}</span>
          <button type="button" class="ib ${favSet.has(favKey(v)) ? 'on' : ''}" data-fav="${i}" title="Yêu thích">${favSet.has(favKey(v)) ? '♥' : '♡'}</button>
          <button type="button" class="ib" data-copy="${i}" title="Sao chép ID: ${esc(v.voiceId)}">⧉</button>
          ${v.previewUrl ? `<button type="button" class="btn sm" data-play="${i}">${playing === favKey(v) ? '■ Dừng' : '▶ Phát'}</button>` : ''}
          <button type="button" class="btn sm ${isSelected(v) ? '' : 'light'}" data-use="${i}">${isSelected(v) ? '✓ Đang dùng' : 'Sử dụng'}</button></div></div>`;
    }

    function drawGrid() {
      const grid = $('#vmGrid');
      const q = (filters().search || '').trim();
      // dán thẳng một voice ID: cho dùng luôn
      const idLike = /^[\w-]{8,}$/.test(q) && /\d/.test(q) && st.tab !== 'fav' && !voices.some((v) => v.voiceId === q);
      const idCard = idLike ? `<div class="vcard vid"><b>Dùng voice ID này</b><p><code>${esc(q)}</code> với ${PROV_NAME[st.provider]}</p><div class="vact"><span></span><button type="button" class="btn sm light" id="vmUseId">Sử dụng</button></div></div>` : '';
      grid.innerHTML = idCard + voices.map(card).join('');
      if (!voices.length && !idCard && !loading) grid.innerHTML = `<div class="vempty">${st.tab === 'fav' ? 'Chưa có giọng yêu thích. Bấm ♡ trên một giọng để lưu vào đây.' : 'Không tìm thấy giọng nào phù hợp.'}</div>`;
      $('#vmUseId')?.addEventListener('click', () => pick({ provider: st.provider, voiceId: q, name: '' }));
      $$('[data-use]', grid).forEach((b) => b.addEventListener('click', () => pick(voices[b.dataset.use])));
      $$('[data-copy]', grid).forEach((b) =>
        b.addEventListener('click', () => {
          navigator.clipboard?.writeText(voices[b.dataset.copy].voiceId).then(
            () => toast('Đã sao chép voice ID', 'ok'),
            () => toast('Không sao chép được', 'err'),
          );
        }),
      );
      $$('[data-play]', grid).forEach((b) =>
        b.addEventListener('click', () => {
          const v = voices[b.dataset.play];
          const key = favKey(v);
          previewAudio?.pause();
          if (playing === key) {
            playing = '';
            return drawGrid();
          }
          playing = key;
          previewAudio = new Audio(v.previewUrl);
          previewAudio.addEventListener('ended', () => playing === key && ((playing = ''), drawGrid()));
          previewAudio.play().catch(() => {
            playing = '';
            drawGrid();
            toast('Không phát được bản nghe thử', 'err');
          });
          drawGrid();
        }),
      );
      $$('[data-fav]', grid).forEach((b) =>
        b.addEventListener('click', async () => {
          const v = voices[b.dataset.fav];
          const on = !favSet.has(favKey(v));
          try {
            favs = await api('PUT', '/api/favorites', { voice: v, on });
            favSet = new Set(favs.map(favKey));
            if (st.tab === 'fav') voices = filterFavs();
            drawGrid();
          } catch (e) {
            toast(e.message, 'err');
          }
        }),
      );
      $('#vmMore').innerHTML = loading ? '<small>Đang tải…</small>' : '';
    }

    function pick(v) {
      close();
      onPick(v);
      toast(`Đã chọn giọng ${v.name || v.voiceId}`, 'ok');
    }

    const filterFavs = () => {
      const q = (filters().search || '').trim().toLowerCase();
      return favs.filter((v) => !q || v.name.toLowerCase().includes(q) || v.voiceId.toLowerCase() === q);
    };

    async function load() {
      const src = source();
      if (src === 'fav') {
        voices = filterFavs();
        hasMore = false;
        return drawGrid();
      }
      if (loading && page > 0) return;
      const my = ++reqId;
      loading = true;
      drawGrid();
      const f = filters();
      const q = new URLSearchParams({ source: src, page: String(page), pageSize: '30' });
      for (const [k, v] of Object.entries(f)) if (v) q.set(k, v);
      try {
        const j = await api('GET', '/api/voices?' + q);
        if (my !== reqId) return;
        voices = page === 0 ? j.voices : voices.concat(j.voices.filter((v) => !voices.some((x) => x.voiceId === v.voiceId)));
        hasMore = !!j.hasMore;
        loading = false;
        drawGrid();
      } catch (e) {
        if (my !== reqId) return;
        loading = false;
        hasMore = false;
        drawGrid();
        $('#vmGrid').innerHTML = `<div class="err">${esc(e.message)}</div>`;
      }
    }

    function reload() {
      saveSt();
      page = 0;
      voices = [];
      hasMore = false;
      loading = false;
      $('#vmBody').scrollTop = 0;
      load();
    }

    function refresh() {
      drawHead();
      drawFilters();
      reload();
    }

    // tải thêm khi cuộn tới cuối
    const observer = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting) && hasMore && !loading) {
          page++;
          load();
        }
      },
      { root: $('#vmBody'), rootMargin: '300px' },
    );
    observer.observe($('#vmMore'));

    let searchT;
    $('#vmSearch').addEventListener('input', (e) => {
      clearTimeout(searchT);
      searchT = setTimeout(() => {
        filters().search = e.target.value.trim();
        reload();
      }, 350);
    });

    drawHead();
    $('#vmGrid').innerHTML = '<small>Đang tải…</small>';
    const [favList] = await Promise.all([api('GET', '/api/favorites').catch(() => []), ...PROVIDERS.map(([p]) => loadLangs(p))]);
    if (m._owner !== token || m.hidden) return; // đã đóng trong lúc chờ
    favs = favList;
    favSet = new Set(favs.map(favKey));
    drawFilters();
    reload();
  }

  // ---------- trang: DỰ ÁN ----------
  let listTimer = null;
  function stopListPoll() {
    clearInterval(listTimer);
    listTimer = null;
  }

  async function renderProjects() {
    $('#app').innerHTML = `<div class="page-head"><h1>Dự án</h1><div class="inline"><a class="btn" href="#/music">+ Video nhạc</a><a class="btn primary" href="#/create">+ Tạo video</a></div></div><div id="plist"><div class="empty">Đang tải…</div></div>`;
    const draw = async () => {
      let list, music;
      try {
        // dự án video thường + video nhạc (mục Video nhạc), xếp chung theo lần sửa gần nhất
        [list, music] = await Promise.all([api('GET', '/api/projects'), api('GET', '/api/music').catch(() => [])]);
      } catch (e) {
        return toast(e.message, 'err');
      }
      const box = $('#plist');
      if (!box) return stopListPoll();
      if (!list.length && !music.length) {
        box.innerHTML = '<div class="empty">Chưa có dự án nào.<br><br><a class="btn primary" href="#/create">Tạo video đầu tiên</a></div>';
        return;
      }
      const items = [...list.map((p) => ({ ...p, kind: 'video' })), ...music.map((p) => ({ ...p, kind: 'music' }))].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      const pill = (p) => `<span class="pill ${p.status}">${STATUS[p.status] || p.status}${['running', 'queued'].includes(p.status) ? ' ' + Math.round(p.progress) + '%' : ''}</span>`;
      const card = (p) =>
        p.kind === 'music'
          ? `<div class="pcard"><div class="th" style="${p.thumb ? `background-image:url('${esc(p.thumb)}')` : ''}">${p.thumb ? '' : 'Chưa có clip'}${pill(p)}</div>
          <div class="bd"><b><span class="tag">🎵 Video nhạc</span>${esc(p.title)}</b><small>${p.orientation === 'portrait' ? '9:16' : '16:9'} · ${p.resolution}p${p.songDuration ? ' · bài hát ' + fmtDur(p.songDuration) : ''} · ${p.lines} câu · ${p.clips} clip${p.hasVideo ? ' · video ' + fmtDur(p.videoDuration) : ''}</small><small>${new Date(p.updatedAt).toLocaleString('vi-VN')}</small></div>
          <div class="ft"><button class="btn sm primary" data-mopen="${p.id}">Mở</button>${p.hasVideo ? `<a class="btn sm" href="/mfiles/${p.id}/${encodeURIComponent(p.videoFile || 'output.mp4')}?download=1">⬇ MP4</a><a class="btn sm" href="/mfiles/${p.id}/lyrics.srt?download=1">SRT</a><button class="btn sm" data-mreveal="${p.id}" title="Mở thư mục dự án trong Finder">📂 Finder</button>` : ''}<button class="btn sm danger" data-mdel="${p.id}">Xoá</button></div></div>`
          : `<div class="pcard"><div class="th" style="${p.thumb ? `background-image:url('${esc(p.thumb)}')` : ''}">${p.thumb ? '' : 'Chưa có ảnh'}${pill(p)}</div>
          <div class="bd"><b>${esc(p.title)}</b><small>${p.orientation === 'portrait' ? '9:16' : '16:9'} · ${p.resolution}p${p.hasAudio ? ' · giọng ' + fmtDur(p.audioDuration) : ''}${p.hasVideo ? ' · video ' + fmtDur(p.videoDuration) : ''}</small><small>${new Date(p.updatedAt).toLocaleString('vi-VN')}</small></div>
          <div class="ft"><button class="btn sm primary" data-open="${p.id}">Mở</button>${p.hasVideo ? `<a class="btn sm" href="/files/${p.id}/output.mp4?download=1">⬇ MP4</a>` : ''}${p.hasAudio ? `<a class="btn sm" href="/files/${p.id}/voice.srt?download=1">SRT</a>` : ''}${p.hasAudio || p.hasVideo ? `<button class="btn sm" data-reveal="${p.id}" title="Mở thư mục dự án trong Finder">📂 Finder</button>` : ''}<button class="btn sm danger" data-del="${p.id}">Xoá</button></div></div>`;
      box.innerHTML = `<div class="grid">${items.map(card).join('')}</div>`;
      $$('[data-open]', box).forEach((b) => b.addEventListener('click', () => openProject(b.dataset.open)));
      $$('[data-reveal]', box).forEach((b) => b.addEventListener('click', () => reveal(b.dataset.reveal)));
      $$('[data-del]', box).forEach((b) =>
        b.addEventListener('click', async () => {
          if (!confirm('Xoá dự án này cùng toàn bộ file của nó?')) return;
          try {
            await api('DELETE', `/api/projects/${b.dataset.del}`);
            if (projectId === b.dataset.del) {
              projectId = null;
              project = null;
            }
            draw();
          } catch (e) {
            toast(e.message, 'err');
          }
        }),
      );
      // video nhạc: mở ở trang Video nhạc
      $$('[data-mopen]', box).forEach((b) =>
        b.addEventListener('click', () => {
          try {
            localStorage.setItem('gva.music.current', b.dataset.mopen);
          } catch (_) {}
          location.hash = '#/music';
        }),
      );
      $$('[data-mreveal]', box).forEach((b) => b.addEventListener('click', () => api('POST', `/api/music/${b.dataset.mreveal}/reveal`).catch((e) => toast(e.message, 'err'))));
      $$('[data-mdel]', box).forEach((b) =>
        b.addEventListener('click', async () => {
          if (!confirm('Xoá video nhạc này cùng toàn bộ file (bài hát, clip, video)?')) return;
          try {
            await api('DELETE', `/api/music/${b.dataset.mdel}`);
            try {
              if (localStorage.getItem('gva.music.current') === b.dataset.mdel) localStorage.removeItem('gva.music.current');
            } catch (_) {}
            draw();
          } catch (e) {
            toast(e.message, 'err');
          }
        }),
      );
      if (!items.some((p) => ['queued', 'running'].includes(p.status))) stopListPoll();
      else if (!listTimer) listTimer = setInterval(draw, 2000);
    };
    await draw();
  }

  async function openProject(id) {
    try {
      const p = await api('GET', `/api/projects/${id}`);
      projectId = p.id;
      project = p;
      form.title = p.title || '';
      form.script = p.script || '';
      form.options = deepMerge(DEFAULT_FORM().options, p.options);
      form.scenePrompts = p.scenePrompts || null;
      images.forEach((i) => i.url?.startsWith('blob:') && URL.revokeObjectURL(i.url));
      images = p.imageList.map((i) => ({ key: nextKey++, file: i.file, blob: null, name: i.name, url: i.url, fx: i.fx || null, desc: i.fx?.ai?.desc || '' }));
      story = null;
      if (p.storyboard?.assign?.length) {
        const { blocks } = await api('POST', '/api/story/blocks', { script: p.script });
        if (blocks.length === p.storyboard.n) story = { blocks, assign: p.storyboard.assign.map((f) => images.find((im) => im.file === f) || null), script: p.script, notes: '', weak: [], model: '' };
      }
      bgm = p.bgm ? { file: p.bgm, blob: null, name: 'Nhạc nền đã tải' } : null;
      saveForm();
      location.hash = '#/create';
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  // ---------- trang: CÀI ĐẶT ----------
  // ----- ô API key: hiện key đã lưu (che bớt), Thay key, Xoá key -----
  const KEY_CLEAR = { apiKey: 'clearApiKey', anthropicKey: 'clearAnthropicKey', geminiKey: 'clearGeminiKey' };
  function keyField(id, { secret, label, placeholder, help, attrs = '' }) {
    return `<div class="field keyfield" id="${id}" data-secret="${secret}" ${attrs}><label>${label}</label>
      <div class="kshow"><span class="kval">🔑 Đã lưu key <code></code></span><button class="btn sm" type="button" data-kact="change">Thay key</button><button class="btn sm danger" type="button" data-kact="del">Xoá key</button></div>
      <div class="kedit inline"><input type="password" autocomplete="off" placeholder="${esc(placeholder)}" /><button class="btn sm" type="button" data-kact="peek">Hiện</button><button class="btn sm ghost" type="button" data-kact="cancel">Huỷ</button></div>
      ${help ? `<small>${help}</small>` : ''}</div>`;
  }
  /** Gắn hành vi cho ô key; trả về { value(), reset() }. onChange() chạy sau khi xoá key. */
  function bindKeyField(id, { name, onChange }) {
    const box = $('#' + id);
    const secret = box.dataset.secret;
    const inp = $('input', box);
    const draw = (editing) => {
      const set = !!settings[secret + 'Set'];
      $('.kval code', box).textContent = settings[secret + 'Hint'] || '';
      $('.kshow', box).hidden = !set || editing;
      $('.kedit', box).hidden = set && !editing;
      $('[data-kact="cancel"]', box).hidden = !set;
    };
    $$('[data-kact]', box).forEach((b) =>
      b.addEventListener('click', async () => {
        const act = b.dataset.kact;
        if (act === 'change') {
          draw(true);
          inp.focus();
        } else if (act === 'cancel') {
          inp.value = '';
          draw(false);
        } else if (act === 'peek') {
          inp.type = inp.type === 'password' ? 'text' : 'password';
          b.textContent = inp.type === 'password' ? 'Hiện' : 'Ẩn';
        } else if (act === 'del') {
          if (!confirm(`Xoá API key ${name} đã lưu trên máy này?`)) return;
          try {
            settings = await api('PUT', '/api/settings', { [KEY_CLEAR[secret]]: true });
            inp.value = '';
            draw(false);
            toast(`Đã xoá key ${name}`, 'ok');
            onChange?.();
          } catch (e) {
            toast(e.message, 'err');
          }
        }
      }),
    );
    draw(false);
    return {
      value: () => inp.value.trim(),
      reset: () => {
        inp.value = '';
        inp.type = 'password';
        $('[data-kact="peek"]', box).textContent = 'Hiện';
        draw(false);
      },
    };
  }

  async function renderSettings() {
    await refreshHealth();
    const s = settings;
    $('#app').innerHTML = `
      <div class="page-head"><h1>Cài đặt</h1></div>
      <section class="card"><h2>API genmax.io</h2>
        ${keyField('kfGenmax', { secret: 'apiKey', label: 'API key (gửi qua header <code>xi-api-key</code>)', placeholder: 'Dán API key genmax.io vào đây', help: 'Key được lưu trong file <code>.env</code> trên máy bạn (đã gitignore, chmod 600), chỉ hiện 4 ký tự cuối, không gửi lên mạng ngoài genmax.io.' })}
        <div class="field"><label>Base URL</label><input type="text" id="sBase" value="${esc(s.baseUrl)}" /><small>Mặc định https://api.genmax.io. Muốn thử không tốn credit: chạy <code>npm run mock</code> rồi đặt http://127.0.0.1:4010</small></div>
        <div class="field"><label class="check"><input type="checkbox" id="sExp" ${s.exportTranscript ? 'checked' : ''} /> Xuất SRT từ genmax (tốn thêm ~15% credit)</label><small>Tắt thì app tự chia SRT theo độ dài câu.</small></div>
        <div class="btns"><button class="btn primary" id="sSave">Lưu cài đặt</button><button class="btn" id="sTest">Kiểm tra key</button></div>
        <div id="sTestOut" class="hint"></div>
      </section>

      <section class="card"><h2>Giọng mặc định</h2>
        <div class="row">
          <div class="field"><label>Nhà cung cấp</label><select id="vProv"><option value="elevenlabs">ElevenLabs</option><option value="minimax">MiniMax</option><option value="capcut">CapCut</option></select></div>
          <div class="field"><label>Model</label><select id="vModel"></select></div>
          <div class="field"><label>Ngôn ngữ</label><input type="text" id="vLang" value="${esc(s.languageCode)}" /></div>
        </div>
        <div class="row">
          <div class="field"><label>Voice ID</label><div class="inline"><input type="text" id="vId" value="${esc(s.voiceId)}" /><button class="btn sm" type="button" id="vPick">Chọn giọng…</button></div></div>
          <div class="field"><label>Tên giọng (hiển thị)</label><input type="text" id="vName" value="${esc(s.voiceName)}" /></div>
        </div>
        <p class="hint">Giọng này được điền sẵn khi bạn bắt đầu form mới. Trong form tạo video vẫn đổi được cho từng kịch bản.</p>
      </section>

      <section class="card"><h2>AI gợi ý hiệu ứng <small>(tuỳ chọn)</small></h2>
        <p class="hint" style="margin-top:0">AI xem từng ảnh asset rồi chọn sẵn hiệu ứng (lửa, mưa, tuyết, sương…) và vị trí đống lửa. Ảnh được thu nhỏ còn ≤1280px trước khi gửi; kết quả được nhớ nên cùng một ảnh không bị tính tiền hai lần.</p>
        <div class="row">
          <div class="field"><label>Nhà cung cấp</label><select id="aiProv"><option value="anthropic">Claude (Anthropic)</option><option value="gemini">Gemini (Google)</option></select></div>
          <div class="field"><label>Model</label><div class="inline"><select id="aiModel"></select><button class="btn sm" type="button" id="aiReload" title="Tải lại danh sách model">↻</button></div><small id="aiModelHint"></small></div>
        </div>
        ${keyField('kfClaude', { secret: 'anthropicKey', label: 'API key Claude', placeholder: 'sk-ant-…', attrs: 'data-aip="anthropic"', help: 'Lấy key: <b>platform.claude.com</b> → Settings → API Keys (cần nạp tiền trả trước ở mục Billing).' })}
        ${keyField('kfGemini', { secret: 'geminiKey', label: 'API key Gemini', placeholder: 'Dán API key Google AI Studio', attrs: 'data-aip="gemini"', help: 'Lấy key: <b>aistudio.google.com</b> → Get API key. Gói miễn phí có thể bị Google dùng dữ liệu để cải thiện sản phẩm; gói trả phí thì không.' })}
        <p class="hint">AI chỉ được gọi khi bạn bấm nút (“🎬 Tự động xếp ảnh theo kịch bản bằng AI”, “🪄 Gợi ý hiệu ứng bằng AI”, “📝 Tạo prompt ảnh…”) — tải ảnh lên không tự gọi AI.</p>
        <div class="btns"><button class="btn primary" id="aiSave" type="button">Lưu cài đặt</button><button class="btn" id="aiTest" type="button">Kiểm tra key</button></div>
        <div id="aiOut" class="hint"></div>
      </section>

      <section class="card"><h2>FFmpeg &amp; phụ đề</h2>
        <div class="row">
          <div class="field"><label>Đường dẫn ffmpeg</label><input type="text" id="fPath" value="${esc(s.ffmpegPath)}" /></div>
          <div class="field"><label>Đường dẫn ffprobe</label><input type="text" id="fProbe" value="${esc(s.ffprobePath)}" /></div>
          <div class="field"><label>Font phụ đề</label><input type="text" id="fFont" value="${esc(s.subtitleFont)}" /><small>Arial, Helvetica Neue, Be Vietnam Pro… (phải cài trên máy, hỗ trợ tiếng Việt)</small></div>
        </div>
        <div class="btns"><button class="btn" id="fCheck">Kiểm tra FFmpeg</button></div>
        <div id="fOut" class="hint">${ffText(health?.ffmpeg)}</div>
      </section>
      <p class="hint">Thư mục dữ liệu: <code>${esc(health?.dataDir || '')}</code> · Node ${esc(health?.node || '')}</p>`;
    $('#vProv').value = s.provider;
    // ----- AI gợi ý hiệu ứng -----
    $('#aiProv').value = s.aiProvider;
    const aiModelKey = (prov) => AI_FIELDS[prov][1];
    const AI_NAME = { anthropic: 'Claude', gemini: 'Gemini' };
    const loadAiModels = async () => {
      const prov = $('#aiProv').value;
      const sel = $('#aiModel');
      const cur = settings[aiModelKey(prov)] || '';
      $$('[data-aip]').forEach((el) => (el.hidden = el.dataset.aip !== prov));
      sel.innerHTML = `<option value="${esc(cur)}">${esc(cur || '— chưa chọn —')}</option>`;
      sel.value = cur;
      const hint = $('#aiModelHint');
      if (!settings[AI_FIELDS[prov][0]]) {
        drawSide();
        return (hint.textContent = 'Nhập API key rồi bấm “Lưu cài đặt” để tải danh sách model.');
      }
      hint.textContent = 'Đang tải danh sách model…';
      try {
        const list = await api('GET', '/api/ai/models?provider=' + prov);
        if ($('#aiProv').value !== prov) return;
        if (!list.length) return (hint.textContent = 'API không trả về model nào nhìn được ảnh.');
        const pick = cur && list.some((m) => m.id === cur) ? cur : (list.find((m) => /argon/i.test(m.id)) || list[0]).id;
        sel.innerHTML = list.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}${m.name !== m.id ? ' — ' + esc(m.id) : ''}</option>`).join('') + (cur && !list.some((m) => m.id === cur) ? `<option value="${esc(cur)}">${esc(cur)} (không còn trong danh sách)</option>` : '');
        sel.value = cur && !list.some((m) => m.id === cur) ? cur : pick;
        hint.textContent = `${list.length} model nhìn được ảnh.`;
        if (sel.value !== cur) settings = await api('PUT', '/api/settings', { [aiModelKey(prov)]: sel.value });
      } catch (e) {
        hint.textContent = '❌ ' + e.message;
      }
      drawSide();
    };
    $('#aiProv').addEventListener('change', async () => {
      settings = await api('PUT', '/api/settings', { aiProvider: $('#aiProv').value }).catch((e) => (toast(e.message, 'err'), settings));
      loadAiModels();
    });
    $('#aiModel').addEventListener('change', async () => {
      settings = await api('PUT', '/api/settings', { [aiModelKey($('#aiProv').value)]: $('#aiModel').value }).catch((e) => (toast(e.message, 'err'), settings));
      toast('Đã chọn model ' + $('#aiModel').value, 'ok');
      drawSide();
    });
    $('#aiReload').addEventListener('click', loadAiModels);
    const onAiKeyRemoved = () => {
      $('#aiOut').textContent = '';
      loadAiModels();
    };
    const kClaude = bindKeyField('kfClaude', { name: 'Claude', onChange: onAiKeyRemoved });
    const kGemini = bindKeyField('kfGemini', { name: 'Gemini', onChange: onAiKeyRemoved });
    const aiKeyOf = () => ({ anthropic: kClaude, gemini: kGemini })[$('#aiProv').value];
    $('#aiSave').addEventListener('click', async () => {
      try {
        settings = await api('PUT', '/api/settings', {
          anthropicKey: kClaude.value(),
          geminiKey: kGemini.value(),
          aiProvider: $('#aiProv').value,
          [aiModelKey($('#aiProv').value)]: $('#aiModel').value,
        });
        kClaude.reset();
        kGemini.reset();
        $('#aiOut').textContent = '';
        toast('Đã lưu cài đặt AI', 'ok');
        await loadAiModels();
      } catch (e) {
        toast(e.message, 'err');
      }
    });
    $('#aiTest').addEventListener('click', async () => {
      const out = $('#aiOut');
      const prov = $('#aiProv').value;
      const name = AI_NAME[prov];
      out.textContent = 'Đang kiểm tra…';
      try {
        const r = await api('POST', '/api/ai/test?provider=' + prov, { key: aiKeyOf().value() });
        out.innerHTML = r.ok
          ? `✅ Key ${name} hợp lệ — ${r.count} model nhìn được ảnh.${r.unsaved ? ' <b>Key này chưa lưu</b> — bấm “Lưu cài đặt” để dùng.' : ''}`
          : `❌ ${esc(r.message || 'Key không hợp lệ')}`;
      } catch (e) {
        out.textContent = '❌ ' + e.message;
      }
    });
    loadAiModels();

    const kGenmax = bindKeyField('kfGenmax', {
      name: 'genmax.io',
      onChange: async () => {
        $('#sTestOut').textContent = '';
        for (const k of Object.keys(modelCache)) delete modelCache[k];
        credits = null;
        await refreshHealth();
      },
    });
    fillModelSelect($('#vModel'), s.provider, s.modelId);
    const setProvider = (prov) => {
      const d = PROVIDER_DEFAULTS[prov];
      $('#vProv').value = prov;
      $('#vLang').value = d.languageCode;
      fillModelSelect($('#vModel'), prov, d.modelId);
    };
    $('#vProv').addEventListener('change', () => setProvider($('#vProv').value));
    $('#vPick').addEventListener('click', () =>
      openVoiceModal({
        current: { provider: $('#vProv').value, voiceId: $('#vId').value.trim(), languageCode: $('#vLang').value.trim() },
        onPick: (v) => {
          if (v.provider !== $('#vProv').value) setProvider(v.provider);
          $('#vId').value = v.voiceId;
          $('#vName').value = v.name;
        },
      }),
    );
    const collect = () => ({
      apiKey: kGenmax.value(),
      baseUrl: $('#sBase').value.trim(),
      exportTranscript: $('#sExp').checked,
      provider: $('#vProv').value,
      modelId: $('#vModel').value,
      languageCode: $('#vLang').value.trim(),
      voiceId: $('#vId').value.trim(),
      voiceName: $('#vName').value.trim(),
      ffmpegPath: $('#fPath').value.trim() || 'ffmpeg',
      ffprobePath: $('#fProbe').value.trim() || 'ffprobe',
      subtitleFont: $('#fFont').value.trim() || 'Arial',
    });
    const save = async () => {
      const hadKey = settings?.apiKeySet;
      settings = await api('PUT', '/api/settings', collect());
      kGenmax.reset();
      for (const k of Object.keys(modelCache)) delete modelCache[k];
      credits = null;
      if (!hadKey && settings.apiKeySet) fillModelSelect($('#vModel'), settings.provider, settings.modelId);
      // áp giọng mặc định cho form hiện tại
      const v = form.options.voice;
      Object.assign(v, { provider: settings.provider, modelId: settings.modelId, languageCode: settings.languageCode, voiceId: settings.voiceId, voiceName: settings.voiceName });
      saveForm();
      await refreshHealth();
    };
    $('#sSave').addEventListener('click', async () => {
      try {
        await save();
        toast('Đã lưu cài đặt', 'ok');
        $('#sTestOut').textContent = '';
      } catch (e) {
        toast(e.message, 'err');
      }
    });
    $('#sTest').addEventListener('click', async () => {
      const out = $('#sTestOut');
      out.textContent = 'Đang kiểm tra…';
      try {
        const r = await api('POST', '/api/settings/test', { apiKey: kGenmax.value(), baseUrl: $('#sBase').value.trim() });
        out.innerHTML = r.ok
          ? `✅ Key hợp lệ${r.credits != null ? ' — còn ' + Number(r.credits).toLocaleString('vi-VN') + ' credit' : ''}.${r.unsaved ? ' <b>Key này chưa lưu</b> — bấm “Lưu cài đặt” để dùng.' : ''}`
          : `❌ ${esc(r.message || 'Key không hợp lệ')}`;
      } catch (e) {
        out.textContent = '❌ ' + e.message;
      }
    });
    $('#fCheck').addEventListener('click', async () => {
      try {
        await save();
        $('#fOut').innerHTML = ffText(health.ffmpeg);
      } catch (e) {
        toast(e.message, 'err');
      }
    });
  }

  function ffText(ff) {
    if (!ff) return '';
    if (!ff.ok) return `❌ ${esc(ff.error || 'FFmpeg thiếu bộ lọc zoompan')}. Cài bằng <code>brew install ffmpeg</code>.`;
    return `✅ ${esc(ff.version)}<br>${ff.libass ? '✅ Có libass (đốt được phụ đề)' : '⚠ Thiếu libass — không đốt được phụ đề'}`;
  }

  // ---------- khởi động ----------
  (async () => {
    await Promise.all([refreshHealth(), api('GET', '/api/effects').then((e) => (EFFECTS = e)).catch(() => {})]);
    if (!hadSavedVoice && settings?.voiceId) {
      Object.assign(form.options.voice, { provider: settings.provider, modelId: settings.modelId, languageCode: settings.languageCode, voiceId: settings.voiceId, voiceName: settings.voiceName });
    }
    route();
  })();
})();
