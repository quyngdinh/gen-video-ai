'use strict';
// Client cho API genmax.io (tương thích kiểu ElevenLabs: header xi-api-key).
// Tài liệu: https://genmax.io/docs

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Genmax {
  constructor(settings) {
    this.base = String(settings.baseUrl || 'https://api.genmax.io').replace(/\/+$/, '');
    this.key = settings.apiKey || '';
  }

  _headers(extra) {
    return { 'xi-api-key': this.key, ...(extra || {}) };
  }

  async _json(method, p, body, signal) {
    if (!this.key) throw new Error('Chưa có API key genmax.io — vào Settings để nhập.');
    const res = await fetch(this.base + p, {
      method,
      headers: this._headers(body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {}
    if (!res.ok) {
      const msg =
        (json && (json.detail?.message || json.detail || json.message || json.error)) || text.slice(0, 300) || res.statusText;
      const err = new Error(`genmax ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  /** Kiểm tra key bằng một lời gọi nhẹ. */
  async testKey() {
    try {
      await this._json('GET', '/v1/default-voices?page_size=1');
    } catch (e) {
      return { ok: false, status: e.status || 0, message: e.message };
    }
    return { ok: true, credits: await this.credits().catch(() => null) };
  }

  /** Số credit còn lại của API key (GET /v1/auth/me -> credit_balance). */
  async credits() {
    const j = await this._json('GET', '/v1/auth/me');
    return findCredits(j);
  }

  /** Model TTS của một nhà cung cấp (elevenlabs | minimax | capcut). */
  async models(provider) {
    const j = await this._json('GET', '/v1/models' + (provider && provider !== 'elevenlabs' ? '?provider=' + encodeURIComponent(provider) : ''));
    return (Array.isArray(j) ? j : [])
      .filter((m) => m && m.model_id && m.can_do_text_to_speech !== false)
      .map((m) => ({
        id: m.model_id,
        name: m.name || m.model_id,
        description: m.description || '',
        badge: m.badge || '',
        creditRatio: m.credit_ratio ?? m.model_rates?.character_cost_multiplier ?? null,
        maxChars: m.maximum_text_length_per_request || null,
      }));
  }

  /** Ngôn ngữ hỗ trợ: [{ code, name }]. MiniMax dùng tên đầy đủ làm code. */
  async languages(provider) {
    const j = await this._json('GET', '/v1/languages' + (provider && provider !== 'elevenlabs' ? '?provider=' + encodeURIComponent(provider) : ''));
    return (Array.isArray(j) ? j : []).filter((l) => l && l.code).map((l) => ({ code: String(l.code), name: String(l.name || l.code) }));
  }

  /**
   * Thư viện giọng, trả về dạng chung cho mọi nguồn:
   * { voices: [{ provider, voiceId, name, description, tags, previewUrl, image, langs, clones, usage }], hasMore }
   * source: el-shared | el-default | mm-system | mm-cloned | cc-system; page tính từ 0.
   */
  async voiceLibrary(source, f = {}) {
    const page = Math.max(0, Number(f.page) || 0);
    const pageSize = Math.min(100, Math.max(1, Number(f.pageSize) || 30));
    const q = new URLSearchParams();
    const set = (k, v) => v && q.set(k, String(v));
    set('search', f.search);
    if (source === 'el-shared') {
      q.set('page_size', pageSize);
      q.set('page', page);
      set('sort', f.sort || 'trending');
      for (const k of ['category', 'gender', 'age', 'accent']) set(k, f[k]);
      set('required_languages', f.language);
      if (f.useCase) q.append('use_cases[]', f.useCase);
      const j = await this._json('GET', '/v1/shared-voices?' + q);
      return { voices: (j.voices || []).map(elVoice), hasMore: !!j.has_more };
    }
    if (source === 'el-default') {
      q.set('page_size', 100);
      const j = await this._json('GET', '/v1/default-voices?' + q);
      return { voices: (j.voices || []).map(elVoice), hasMore: false };
    }
    if (source === 'mm-system' || source === 'cc-system') {
      q.set('page_size', pageSize);
      q.set('page', page + 1);
      for (const k of ['gender', 'language', 'accent', 'age']) set(k, f[k]);
      if (source === 'mm-system') {
        set('use_cases', f.useCase);
        const j = await this._json('GET', '/v1/minimax/system-voices?' + q);
        return { voices: (j.voice_list || []).map(mmVoice), hasMore: !!j.has_more, total: j.total };
      }
      set('emotion', f.emotion);
      const j = await this._json('GET', '/v1/capcut/system-voices?' + q);
      return { voices: (j.voice_list || []).map(ccVoice), hasMore: !!j.has_more, total: j.total };
    }
    if (source === 'mm-cloned') {
      const j = await this._json('GET', '/v1/minimax/voices');
      const s = String(f.search || '').toLowerCase();
      const voices = (j.voices || [])
        .filter((v) => v.status === 'done' && (!s || String(v.voice_name).toLowerCase().includes(s) || v.id === f.search))
        .map((v) => ({
          provider: 'minimax',
          voiceId: v.id,
          name: v.voice_name || v.id,
          description: 'Giọng bạn đã clone',
          tags: [v.language_tag, v.gender].filter(Boolean),
          previewUrl: v.sample_audio_url || '',
          image: v.cover_url || '',
          langs: v.language_tag ? [v.language_tag] : [],
        }));
      return { voices, hasMore: false };
    }
    throw Object.assign(new Error('Nguồn giọng không hợp lệ: ' + source), { status: 400 });
  }

  /** Tạo task TTS, trả về id. */
  async createTts({ text, voiceId, provider, modelId, languageCode, voiceSettings, exportTranscript }, signal) {
    if (!voiceId) throw new Error('Chưa chọn giọng (voice ID).');
    const body = { text, provider, language_code: languageCode, voice_settings: voiceSettings };
    if (provider === 'capcut') body.model_id = 'capcut';
    else if (modelId) body.model_id = modelId;
    if (exportTranscript) body.export_transcript = true;
    const j = await this._json('POST', `/v1/text-to-speech/${encodeURIComponent(voiceId)}`, body, signal);
    const id = j && (j.id || j.task_id);
    if (!id) throw new Error('genmax không trả về id task: ' + JSON.stringify(j).slice(0, 200));
    return id;
  }

  async getHistory(id, signal) {
    return this._json('GET', `/v1/history/${encodeURIComponent(id)}`, null, signal);
  }

  /** Chờ task xong (status: pending | processing | completed | failed). */
  async waitForTask(id, { signal, onProgress, timeoutMs = 15 * 60 * 1000, intervalMs = 2000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      if (signal?.aborted) throw new Error('Đã huỷ');
      const task = await this.getHistory(id, signal);
      const st = String(task.status || '').toLowerCase();
      if (onProgress) onProgress(task);
      if (st === 'completed') return task;
      if (st === 'failed' || st === 'error') throw new Error('genmax báo lỗi tạo giọng: ' + (task.error || 'không rõ'));
      if (Date.now() - t0 > timeoutMs) throw new Error('Quá thời gian chờ genmax tạo giọng.');
      await sleep(intervalMs);
    }
  }

  /** Tải file; chỉ gửi API key nếu cùng host với genmax (không rò key ra host khác). */
  async download(u, signal) {
    const abs = new URL(u, this.base + '/');
    const same = abs.origin === new URL(this.base).origin;
    const res = await fetch(abs, {
      headers: same ? this._headers() : {},
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000),
    });
    if (!res.ok) throw new Error(`Tải file thất bại (${res.status}): ${abs.pathname}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

// ---------- chuẩn hoá giọng từ từng nguồn ----------
function elVoice(v) {
  const langs = [...new Set([v.language, ...(v.verified_languages || []).map((l) => l.language_id)].filter(Boolean))];
  return {
    provider: 'elevenlabs',
    voiceId: v.voice_id,
    name: v.name || v.voice_id,
    description: v.description || '',
    tags: [v.accent, v.gender, v.age].filter(Boolean),
    previewUrl: v.preview_url || '',
    image: v.image_url || '',
    langs,
    clones: v.cloned_by_count ?? null,
    usage: v.usage_character_count_1y ?? null,
  };
}

function mmVoice(v) {
  const tags = v.tag_list || [];
  return {
    provider: 'minimax',
    voiceId: String(v.voice_id),
    name: v.voice_name || v.uniq_id || String(v.voice_id),
    description: v.description || '',
    tags: tags.slice(1, 4).filter((t) => t !== 'Standard'),
    previewUrl: v.sample_audio || '',
    image: v.cover_url || '',
    langs: tags[0] ? [tags[0]] : [],
  };
}

function ccVoice(v) {
  // tag của CapCut lẫn tiếng Trung; chỉ giữ tag Latin cho dễ đọc
  const tags = [v.gender, ...(v.tags || [])].filter((t) => t && /^[\x20-\x7e]+$/.test(t));
  return {
    provider: 'capcut',
    voiceId: String(v.voice_id),
    name: v.name || String(v.voice_id),
    description: '',
    tags: [...new Set(tags.map((t) => t.toLowerCase()))].slice(0, 4),
    previewUrl: v.preview_url || '',
    image: v.image_url || '',
    langs: v.language ? [v.language] : [],
  };
}

function findCredits(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (/credit|balance/i.test(k) && typeof v === 'number') return v;
  }
  for (const v of Object.values(obj)) {
    const r = findCredits(v, depth + 1);
    if (r !== null) return r;
  }
  return null;
}

/** Lấy URL audio từ task đã xong. */
function audioUrlOf(task) {
  const r = task.result || {};
  return r.audio_url || r.url || task.audio_url || null;
}

/** Tìm SRT trong result: URL, hoặc nội dung SRT trả thẳng. */
function srtOf(task) {
  const found = [];
  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 3) return;
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && /srt|transcript|subtitle|caption/i.test(k)) found.push(v);
      else if (v && typeof v === 'object') walk(v, depth + 1);
    }
  })(task.result || {}, 0);
  for (const v of found) {
    if (v.includes('-->')) return { text: v };
    if (/^https?:\/\//i.test(v) || v.startsWith('/')) return { url: v };
  }
  return null;
}

module.exports = { Genmax, audioUrlOf, srtOf };
