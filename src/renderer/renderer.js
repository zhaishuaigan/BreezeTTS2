'use strict';

/* ------------------------------------------------------------------
   Breeze TTS 2 — 渲染进程
   直接调用 breeze-server 的本地接口：
     GET    /health                -> { ws_port }
     GET    /v1/voices             -> 音色列表
     POST   /v1/voices             -> 注册 / 保存音色（multipart）
     PATCH  /v1/voices/:id         -> 更新描述与附加字段（JSON）
     DELETE /v1/voices/:id         -> 删除音色
     POST   /v1/audio/speech       -> s16le PCM（multipart，X-Sample-Rate）
     POST   /v1/audio/convert      -> s16le PCM（multipart，X-Sample-Rate）
     ws://127.0.0.1:<ws_port>      -> 流式生成会话
------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------------- 元素 ---------------- */
const elBoot = $('#boot');
const elRing = $('#ring');
const elBootStatus = $('#bootStatus');
const elProgressWrap = $('#progressWrap');
const elProgressBar = $('#progressBar');
const elProgressLabel = $('#progressLabel');
const elProgressPct = $('#progressPct');
const elProgressSpeed = $('#progressSpeed');
const elErrorBox = $('#errorBox');
const elErrorText = $('#errorText');
const elApp = $('#app');
const elSvcPill = $('#svcPill');
const elSvcText = $('#svcText');
const elStatusPill = $('#statusPill');
const elStreamOpts = $('#streamOpts');
const elStreamToggle = $('#streamToggle');
const elBufRange = $('#bufRange');
const elBufVal = $('#bufVal');
const elPlayBtn = $('#playBtn');
const elIconPlay = $('#iconPlay');
const elIconPause = $('#iconPause');
const elStopBtn = $('#stopBtn');
const elDlBtn = $('#dlBtn');
const elAudio = $('#audio');
const elWaveBox = $('#waveBox');
const elWaveCanvas = $('#waveCanvas');
const elWaveEmpty = $('#waveEmpty');
const elTimeCur = $('#timeCur');
const elTimeTot = $('#timeTot');
const elDockHint = $('#dockHint');
const elLibFilter = $('#libFilter');
const elLibRefresh = $('#libRefresh');
const elLibCount = $('#libCount');
const elVoiceGrid = $('#voiceGrid');
const elToasts = $('#toasts');

/* ---------------- 全局状态 ---------------- */
const state = {
  base: '',
  wsPort: 0,
  voices: [],
  busy: false,
  socket: null,
  abort: null,
  live: null,
  sr: 24000,
  pcm: null,
  peaks: null,
  duration: 0,
  progress: 0,
  objectUrl: ''
};

/* ================= 1. 启动流程 ================= */

let lastByte = 0;
let lastTs = 0;
let speed = 0;

function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b >= 100 ? 0 : 1)} ${u[i]}`;
}

function bootStatus(msg) {
  elBootStatus.textContent = msg;
  elErrorBox.hidden = true;
}

window.breeze.onStatus((msg) => {
  if (elBoot.hidden) return;
  bootStatus(msg);
});

window.breeze.onProgress((p) => {
  if (elRing) elRing.style.display = 'none';
  elProgressWrap.hidden = false;
  const pct = p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : 0;
  elProgressBar.style.width = pct + '%';
  elProgressLabel.textContent = `${p.label}（${p.step}/${p.steps}）`;
  elProgressPct.textContent = `${pct}% · ${fmtBytes(p.received)} / ${fmtBytes(p.total)}`;

  const now = Date.now();
  if (lastTs) {
    const dt = (now - lastTs) / 1000;
    if (dt > 0.4) {
      speed = speed * 0.7 + ((p.received - lastByte) / dt) * 0.3;
      lastByte = p.received;
      lastTs = now;
    }
  } else {
    lastByte = p.received;
    lastTs = now;
  }
  if (p.total && speed > 0) {
    const eta = (p.total - p.received) / speed;
    elProgressSpeed.textContent = `${fmtBytes(speed)}/s · 剩余约 ${Math.ceil(eta / 60)} 分钟`;
  }
});

window.breeze.onReady(async (info) => {
  state.base = `http://127.0.0.1:${info.port}`;
  state.wsPort = info.wsPort || 0;
  elSvcPill.dataset.state = 'ok';
  elSvcText.textContent = `本地服务已就绪 · 端口 ${info.port}`;
  enterApp();
  await loadVoices();
});

window.breeze.onError((err) => {
  showBootError(err && err.message ? err.message : String(err));
});

function showBootError(message) {
  elBoot.hidden = false;
  elBoot.classList.remove('leaving');
  elApp.hidden = true;
  elRing.style.display = 'none';
  elProgressWrap.hidden = true;
  elErrorBox.hidden = false;
  elErrorText.textContent = message;
  elBootStatus.textContent = '启动失败';
  elSvcPill.dataset.state = 'err';
  elSvcText.textContent = '服务异常';
}

function enterApp() {
  elApp.hidden = false;
  elBoot.classList.add('leaving');
  setTimeout(() => {
    elBoot.hidden = true;
    elBoot.classList.remove('leaving');
    resizeWave();
  }, 460);
}

$('#btnRetry').addEventListener('click', () => {
  elRing.style.display = '';
  elProgressWrap.hidden = true;
  elErrorBox.hidden = true;
  elProgressBar.style.width = '0%';
  elBootStatus.textContent = '正在重试…';
  elSvcPill.dataset.state = 'work';
  elSvcText.textContent = '服务启动中…';
  lastByte = 0; lastTs = 0; speed = 0;
  window.breeze.retry();
});
$('#btnQuit').addEventListener('click', () => window.breeze.quit());

/* ================= 2. 无边框窗口控制 ================= */

$('#winMin').addEventListener('click', () => window.breeze.win.minimize());
$('#winMax').addEventListener('click', () => window.breeze.win.toggleMaximize());
$('#winClose').addEventListener('click', () => window.breeze.win.close());

window.breeze.onWindowState((s) => {
  document.body.classList.toggle('maximized', !!s.maximized);
  $('#winMax').title = s.maximized ? '还原' : '最大化';
});
window.breeze.win.getState().then((s) => {
  document.body.classList.toggle('maximized', !!s.maximized);
  $('#winMax').title = s.maximized ? '还原' : '最大化';
});

/* ================= 3. 面板切换 ================= */

const PANEL_HINTS = {
  design: 'Ctrl + Enter 快速生成',
  clone: 'Ctrl + Enter 快速生成',
  direction: 'Ctrl + Enter 快速生成',
  changer: '转换完成后可保存 WAV',
  library: '点击「使用」把音色载入克隆页'
};

function switchPanel(name) {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
  $('#doc').scrollTop = 0;
  elStreamOpts.classList.toggle('hide', name === 'changer' || name === 'library');
  elDockHint.textContent = PANEL_HINTS[name] || '';
  if (name === 'library') loadVoices();
}

$$('.nav-item').forEach((btn) => btn.addEventListener('click', () => switchPanel(btn.dataset.panel)));

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    const panel = $('.panel.active');
    const btn = panel && panel.querySelector('.go');
    if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
  }
});

/* ================= 4. 音色列表 ================= */

async function loadVoices() {
  if (!state.base) return;
  try {
    const res = await fetch(state.base + '/v1/voices');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    state.voices = await res.json();
  } catch (err) {
    state.voices = [];
    toast('读取音色列表失败：' + err.message, 'err');
  }
  renderVoiceSelects();
  renderLibrary();
}

function renderVoiceSelects() {
  $$('select[data-voice]').forEach((sel) => {
    const keep = sel.value;
    sel.textContent = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = sel.dataset.voice === 'changer' ? '使用上传的目标音频' : '使用上传的音频片段';
    sel.appendChild(none);
    for (const v of state.voices) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = `${v.id} · ${v.seconds.toFixed(1)}s${v.saved ? '' : ' · 临时'}`;
      if (v.description) opt.title = v.description;
      sel.appendChild(opt);
    }
    sel.value = state.voices.some((v) => v.id === keep) ? keep : '';
    syncVoice(sel.dataset.voice);
  });
}

function syncVoice(name) {
  const sel = $(`select[data-voice="${name}"]`);
  if (!sel) return;
  const block = $(`[data-refblock="${name}"]`);
  const desc = $(`[data-vdesc="${name}"]`);
  const voice = state.voices.find((v) => v.id === sel.value);
  if (block) block.classList.toggle('hide', !!sel.value);
  if (desc) {
    desc.textContent = voice ? voice.description || '' : '';
    desc.classList.toggle('show', !!(voice && voice.description));
  }
}

$$('select[data-voice]').forEach((sel) => {
  sel.addEventListener('change', () => syncVoice(sel.dataset.voice));
});

/* ================= 5. 保存音色 ================= */

$$('.save-voice').forEach((btn) => {
  btn.addEventListener('click', () => saveVoice(btn.dataset.save));
});

async function saveVoice(name) {
  const voiceName = textOf(`[data-save-name="${name}"]`);
  if (!voiceName) return toast('请先为音色命名', 'err');
  if (!/^[A-Za-z0-9_-]+$/.test(voiceName)) {
    return toast('名称只能包含字母、数字、连字符和下划线', 'err');
  }
  const file = fileOf(`[data-ref-audio="${name}"]`);
  const refText = textOf(`[data-ref-text="${name}"]`);
  if (!file || !refText) return toast('保存音色需要音频片段及其文本', 'err');

  const btn = $(`.save-voice[data-save="${name}"]`);
  btn.disabled = true;
  setStatus('正在保存音色…', 'work');
  try {
    const form = new FormData();
    form.append('name', voiceName);
    form.append('ref_audio', file);
    form.append('ref_text', refText);
    const desc = textOf(`[data-save-desc="${name}"]`);
    if (desc) form.append('description', desc);

    const res = await fetch(state.base + '/v1/voices', { method: 'POST', body: form });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);

    await loadVoices();
    $$('select[data-voice]').forEach((sel) => {
      if (state.voices.some((v) => v.id === body.id)) sel.value = body.id;
      syncVoice(sel.dataset.voice);
    });
    toast(`音色已保存：${body.id}`, 'ok');
    setStatus(`已保存音色 ${body.id} · ${(body.seconds || 0).toFixed(2)}s`, 'ok');
  } catch (err) {
    toast('保存失败：' + err.message, 'err');
    setStatus('保存失败', 'err');
  }
  btn.disabled = false;
}

/* ================= 6. 生成 / 转换 ================= */

$$('.go').forEach((btn) => {
  btn.addEventListener('click', () => {
    const panel = btn.closest('.panel');
    if (!panel) return;
    const name = panel.id.replace('panel-', '');
    if (name === 'changer') runConvert();
    else runSpeech(name);
  });
});

function panelData(name) {
  const d = {
    name,
    voiceId: ($(`select[data-voice="${name}"]`) || {}).value || '',
    refAudio: fileOf(`[data-ref-audio="${name}"]`),
    refText: textOf(`[data-ref-text="${name}"]`),
    text: '',
    instruction: '',
    cfg: 1,
    seed: 42,
    source: null,
    keep: 0
  };
  if (name === 'design') {
    d.text = textOf('#design-text');
    d.instruction = textOf('#design-instruction');
    d.cfg = numOf('#design-cfg', 1);
    d.seed = numOf('#design-seed', 42);
  } else if (name === 'clone') {
    d.text = textOf('#clone-text');
    d.seed = numOf('#clone-seed', 42);
  } else if (name === 'direction') {
    d.text = textOf('#direction-text');
    d.instruction = textOf('#direction-instruction');
    d.cfg = numOf('#direction-cfg', 1);
    d.seed = numOf('#direction-seed', 42);
  } else if (name === 'changer') {
    d.source = fileOf('[data-source]');
    d.text = textOf('#changer-text');
    d.keep = numOf('#changer-keep', 0);
    d.seed = numOf('#changer-seed', 42);
  }
  return d;
}

async function runSpeech(name) {
  if (state.busy) return toast('正在处理上一个请求，请稍候', 'err');
  const d = panelData(name);
  if (!d.text) return toast('请输入要朗读的文本', 'err');
  if (name === 'clone' && !d.voiceId && !d.refAudio) {
    return toast('请上传参考音频，或选择一个已保存音色', 'err');
  }

  startWork();
  closeLive();
  clearOutput();
  try {
    let voiceId = d.voiceId;
    if (!voiceId && d.refAudio) {
      setStatus('正在编码参考音频…', 'work');
      voiceId = await encodeReference(d.refAudio, d.refText);
    }
    d.voiceId = voiceId;
    if (state.wsPort) await synthSocket(d);
    else await synthHttp(d);
  } catch (err) {
    handleError(err);
  } finally {
    endWork();
  }
}

async function encodeReference(file, refText) {
  const form = new FormData();
  form.append('ref_audio', file);
  form.append('ref_text', refText || '');
  const res = await fetch(state.base + '/v1/voices', { method: 'POST', body: form });
  if (!res.ok) {
    throw new Error(res.status === 409 ? '服务繁忙，请稍后再试' : '参考音频编码失败（HTTP ' + res.status + '）');
  }
  const voice = await res.json();
  await loadVoices();
  return voice.id;
}

function synthSocket(d) {
  return new Promise((resolve, reject) => {
    const streaming = elStreamToggle.checked;
    const lead = streaming ? Number(elBufRange.value) : Infinity;
    const sock = new WebSocket(`ws://127.0.0.1:${state.wsPort}`);
    sock.binaryType = 'arraybuffer';
    state.socket = sock;

    let sr = state.sr;
    let live = null;
    let settled = false;
    let lastDraw = 0;

    const finish = (cancelled) => {
      if (settled) return;
      settled = true;
      if (live) live.finish();
      const pcm = live ? live.join() : new Int16Array(0);
      const secs = pcm.length / sr;
      try { sock.close(); } catch (e) { /* noop */ }
      state.socket = null;
      if (pcm.length) {
        finishAudio(pcm, sr, { autoplay: !streaming && !cancelled });
        setStatus(cancelled ? `已停止 · ${secs.toFixed(2)}s` : `完成 · ${secs.toFixed(2)}s`, cancelled ? 'idle' : 'ok');
      } else {
        setStatus(cancelled ? '已停止' : '没有收到音频', cancelled ? 'idle' : 'err');
      }
      resolve();
    };

    sock.onopen = () => setStatus('已连接，等待生成…', 'work');

    sock.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const chunk = new Uint8Array(ev.data);
        if (!chunk.length) return;
        if (!live) {
          live = new LivePlayer(sr, lead);
          state.live = live;
        }
        live.push(chunk);
        const now = performance.now();
        if (now - lastDraw > 180) {
          lastDraw = now;
          updateLiveWave(live, sr);
        }
        setStatus(`${streaming ? '实时播放' : '生成中'} · ${live.seconds.toFixed(2)}s`, 'work');
        return;
      }
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'ready') {
        sr = msg.sample_rate || 24000;
        state.sr = sr;
        sock.send(JSON.stringify({
          type: 'start',
          voice_id: d.voiceId || '',
          instruction: d.instruction || 'Speak clearly and naturally.',
          ref_text: d.refText || '',
          cfg_scale: d.cfg,
          seed: d.seed
        }));
        sock.send(JSON.stringify({ type: 'end', text: d.text }));
        setStatus('生成中…', 'work');
      } else if (msg.type === 'queued') {
        setStatus('排队中，等待 GPU…', 'work');
      } else if (msg.type === 'cancelled') {
        finish(true);
      } else if (msg.type === 'done') {
        finish(false);
      } else if (msg.type === 'error') {
        settled = true;
        try { sock.close(); } catch (e) { /* noop */ }
        state.socket = null;
        closeLive();
        reject(new Error(msg.message || '生成失败'));
      }
    };

    sock.onerror = () => {
      if (settled) return;
      settled = true;
      state.socket = null;
      reject(new Error('流式连接失败'));
    };

    sock.onclose = () => {
      if (settled) return;
      settled = true;
      state.socket = null;
      const pcm = live ? live.join() : new Int16Array(0);
      if (pcm.length) {
        finishAudio(pcm, sr, { autoplay: false });
        setStatus(`完成 · ${(pcm.length / sr).toFixed(2)}s`, 'ok');
        resolve();
      } else {
        reject(new Error('流式连接中断'));
      }
    };
  });
}

async function synthHttp(d) {
  const streaming = elStreamToggle.checked;
  const form = new FormData();
  form.append('text', d.text);
  form.append('seed', String(d.seed));
  form.append('cfg_scale', String(d.cfg));
  form.append('instruction', d.instruction || 'Speak clearly and naturally.');
  form.append('ref_text', d.refText || '');
  if (d.voiceId) form.append('voice_id', d.voiceId);
  else if (d.refAudio) form.append('ref_audio', d.refAudio);

  const abort = new AbortController();
  state.abort = abort;
  const res = await fetch(state.base + '/v1/audio/speech', {
    method: 'POST',
    body: form,
    signal: abort.signal
  });
  if (!res.ok) {
    throw new Error(res.status === 409 ? '服务繁忙，请稍后再试' : '生成失败（HTTP ' + res.status + '）');
  }
  const sr = parseInt(res.headers.get('X-Sample-Rate') || '24000', 10);
  state.sr = sr;

  const live = new LivePlayer(sr, streaming ? Number(elBufRange.value) : Infinity);
  state.live = live;
  const reader = res.body.getReader();
  let lastDraw = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || !value.length) continue;
    live.push(value);
    const now = performance.now();
    if (now - lastDraw > 180) {
      lastDraw = now;
      updateLiveWave(live, sr);
    }
    setStatus(`${streaming ? '实时播放' : '生成中'} · ${live.seconds.toFixed(2)}s`, 'work');
  }
  live.finish();
  const pcm = live.join();
  finishAudio(pcm, sr, { autoplay: !streaming });
  setStatus(`完成 · ${live.seconds.toFixed(2)}s`, 'ok');
}

async function runConvert() {
  if (state.busy) return toast('正在处理上一个请求，请稍候', 'err');
  const d = panelData('changer');
  if (!d.source) return toast('请提供源音频（WAV）', 'err');
  if (!d.voiceId && !d.refAudio) return toast('请选择已保存音色，或上传目标音色', 'err');
  if (!d.voiceId && !d.refText) return toast('请填写目标音色文本（需完全一致）', 'err');

  startWork();
  clearOutput();
  const abort = new AbortController();
  state.abort = abort;
  setStatus('正在转换…', 'work');
  try {
    const form = new FormData();
    form.append('source', d.source);
    if (d.voiceId) {
      form.append('voice_id', d.voiceId);
    } else {
      form.append('ref_audio', d.refAudio);
      form.append('ref_text', d.refText);
    }
    form.append('text', d.text || '');
    form.append('keep_acoustic', String(d.keep));
    form.append('seed', String(d.seed));

    const res = await fetch(state.base + '/v1/audio/convert', { method: 'POST', body: form, signal: abort.signal });
    if (!res.ok) {
      throw new Error(res.status === 409 ? '服务繁忙，请稍后再试' : '转换失败（HTTP ' + res.status + '）');
    }
    const sr = parseInt(res.headers.get('X-Sample-Rate') || '24000', 10);
    state.sr = sr;
    const reader = res.body.getReader();
    const parts = [];
    let bytes = 0;
    let lastDraw = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;
      parts.push(value);
      bytes += value.length;
      const now = performance.now();
      if (now - lastDraw > 180) {
        lastDraw = now;
        const pcm = joinPcm(parts);
        state.peaks = computePeaks(pcm, 180);
        state.duration = pcm.length / sr;
        elWaveEmpty.hidden = true;
        elTimeTot.textContent = fmtTime(state.duration);
        drawWave(1);
      }
      setStatus(`接收中 · ${(bytes / 2 / sr).toFixed(2)}s`, 'work');
    }
    const pcm = joinPcm(parts);
    finishAudio(pcm, sr, { autoplay: true });
    setStatus(`完成 · ${(pcm.length / sr).toFixed(2)}s`, 'ok');
  } catch (err) {
    handleError(err);
  } finally {
    endWork();
  }
}

/* ================= 7. 生成状态与停止 ================= */

function startWork() {
  state.busy = true;
  $$('.go').forEach((b) => { b.disabled = true; });
  elStopBtn.hidden = false;
  setStatus('准备中…', 'work');
}

function endWork() {
  state.busy = false;
  state.abort = null;
  $$('.go').forEach((b) => { b.disabled = false; });
  elStopBtn.hidden = true;
}

function handleError(err) {
  if (err && err.name === 'AbortError') {
    setStatus('已停止', 'idle');
    return;
  }
  setStatus('出错', 'err');
  toast(err && err.message ? err.message : String(err), 'err');
}

elStopBtn.addEventListener('click', () => {
  if (!state.busy) return;
  setStatus('正在停止…', 'work');
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify({ type: 'cancel' }));
  } else if (state.abort) {
    state.abort.abort();
    endWork();
  } else {
    endWork();
    closeLive();
    setStatus('已停止', 'idle');
  }
});

/* ================= 8. 音频播放 / 波形 ================= */

class LivePlayer {
  constructor(sampleRate, lead) {
    this.sr = sampleRate;
    this.lead = lead;
    this.muted = !Number.isFinite(lead);
    this.chunks = [];
    this.leftover = new Uint8Array(0);
    this.queue = [];
    this.queuedSecs = 0;
    this.playhead = 0;
    this.started = false;
    this.samples = 0;
    this.underruns = 0;
    this.ctx = null;
    if (!this.muted) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      try {
        this.ctx = new Ctor({ sampleRate });
      } catch (e) {
        this.ctx = new Ctor();
      }
      this.ctx.resume().catch(() => {});
    }
  }

  push(chunk) {
    this.chunks.push(chunk);
    let bytes = chunk;
    if (this.leftover.length) {
      bytes = new Uint8Array(this.leftover.length + chunk.length);
      bytes.set(this.leftover, 0);
      bytes.set(chunk, this.leftover.length);
    }
    const n = bytes.length >> 1;
    this.leftover = bytes.slice(n * 2);
    if (!n) return;
    this.samples += n;
    if (this.muted) return;

    const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
    const abuf = this.ctx.createBuffer(1, n, this.sr);
    const chan = abuf.getChannelData(0);
    for (let i = 0; i < n; i++) chan[i] = view.getInt16(i * 2, true) / 32768;

    if (!this.started) {
      this.queue.push(abuf);
      this.queuedSecs += abuf.duration;
      if (this.queuedSecs >= this.lead) this.flush();
    } else {
      this.play(abuf);
    }
  }

  flush() {
    this.queue.forEach((b) => this.play(b));
    this.queue = [];
    this.queuedSecs = 0;
  }

  play(abuf) {
    const src = this.ctx.createBufferSource();
    src.buffer = abuf;
    src.connect(this.ctx.destination);
    let at = this.playhead;
    if (!this.started || this.playhead <= this.ctx.currentTime) {
      at = this.ctx.currentTime + 0.02;
      if (this.started) {
        this.underruns++;
        this.lead = Math.min(this.lead * 1.5 + 0.25, 5);
      }
    }
    src.start(at);
    this.started = true;
    this.playhead = at + abuf.duration;
  }

  finish() {
    if (this.muted) return;
    if (this.queue.length) this.flush();
  }

  join() {
    let len = 0;
    for (const c of this.chunks) len += c.length;
    const bytes = new Uint8Array(len);
    let off = 0;
    for (const c of this.chunks) { bytes.set(c, off); off += c.length; }
    return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  }

  get seconds() { return this.samples / this.sr; }

  close() {
    if (this.ctx) { try { this.ctx.close(); } catch (e) { /* noop */ } }
    this.ctx = null;
  }
}

function closeLive() {
  if (state.live) { state.live.close(); state.live = null; }
}

function updateLiveWave(live, sr) {
  const pcm = live.join();
  state.peaks = computePeaks(pcm, 180);
  state.duration = pcm.length / sr;
  elWaveEmpty.hidden = true;
  elTimeTot.textContent = fmtTime(state.duration);
  drawWave(1);
}

function joinPcm(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const bytes = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { bytes.set(p, off); off += p.length; }
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
}

function computePeaks(pcm, bars) {
  const peaks = new Float32Array(bars);
  if (!pcm || !pcm.length) return peaks;
  const size = Math.max(1, Math.floor(pcm.length / bars));
  for (let b = 0; b < bars; b++) {
    let max = 0;
    const start = b * size;
    const end = Math.min(pcm.length, start + size);
    for (let i = start; i < end; i++) {
      const a = Math.abs(pcm[i]);
      if (a > max) max = a;
    }
    peaks[b] = max / 32768;
  }
  return peaks;
}

function fitCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = elWaveBox.clientWidth;
  const h = elWaveBox.clientHeight;
  if (!w || !h) return null;
  if (elWaveCanvas.width !== Math.round(w * dpr) || elWaveCanvas.height !== Math.round(h * dpr)) {
    elWaveCanvas.width = Math.round(w * dpr);
    elWaveCanvas.height = Math.round(h * dpr);
  }
  const ctx = elWaveCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function drawWave(progress) {
  state.progress = progress === undefined ? state.progress : progress;
  const fit = fitCanvas();
  if (!fit) return;
  const { ctx, w, h } = fit;
  ctx.clearRect(0, 0, w, h);

  const peaks = state.peaks;
  if (!peaks || !peaks.length) return;

  const bars = Math.min(peaks.length, Math.floor(w / 5));
  if (bars <= 0) return;
  const gap = w / bars;
  const barW = Math.max(2, gap * 0.52);
  const mid = h / 2;
  const maxH = h * 0.42;
  const playedBars = Math.round(bars * Math.max(0, Math.min(1, state.progress)));

  for (let i = 0; i < bars; i++) {
    const idx = Math.floor((i / bars) * peaks.length);
    const amp = Math.max(0.035, peaks[idx]);
    const bh = amp * maxH;
    const x = i * gap + (gap - barW) / 2;
    if (i < playedBars) {
      ctx.fillStyle = 'rgba(110, 231, 208, 0.92)';
      ctx.fillRect(x, mid - bh, barW, bh * 2);
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
      ctx.fillRect(x, mid - bh, barW, bh * 2);
    }
  }

  if (playedBars > 0 && playedBars < bars) {
    ctx.fillStyle = 'rgba(110, 231, 208, 0.55)';
    ctx.fillRect(playedBars * gap, 0, 1.5, h);
  }
}

function resizeWave() {
  drawWave(state.progress);
}

window.addEventListener('resize', resizeWave);
if (window.ResizeObserver) new ResizeObserver(() => resizeWave()).observe(elWaveBox);

elWaveBox.addEventListener('click', (e) => {
  if (!elAudio.src || !Number.isFinite(elAudio.duration) || elAudio.duration <= 0) return;
  const rect = elWaveBox.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  elAudio.currentTime = ratio * elAudio.duration;
  drawWave(ratio);
});

elAudio.addEventListener('timeupdate', () => {
  elTimeCur.textContent = fmtTime(elAudio.currentTime);
  if (elAudio.duration > 0) drawWave(elAudio.currentTime / elAudio.duration);
});
elAudio.addEventListener('loadedmetadata', () => {
  elTimeTot.textContent = fmtTime(elAudio.duration || state.duration);
});
elAudio.addEventListener('play', () => setPlayIcon(true));
elAudio.addEventListener('pause', () => setPlayIcon(false));
elAudio.addEventListener('ended', () => setPlayIcon(false));

elPlayBtn.addEventListener('click', () => {
  if (!elAudio.src) return;
  if (elAudio.paused) elAudio.play().catch(() => {});
  else elAudio.pause();
});

function setPlayIcon(playing) {
  if (playing) {
    elPlayBtn.setAttribute('aria-label', '暂停');
    elIconPlay.setAttribute('hidden', '');
    elIconPause.removeAttribute('hidden');
  } else {
    elIconPlay.removeAttribute('hidden');
    elIconPause.setAttribute('hidden', '');
    elPlayBtn.setAttribute('aria-label', '播放');
  }
  elIconPlay.hidden = playing;
  elIconPause.hidden = !playing;
  elPlayBtn.setAttribute('aria-label', playing ? '暂停' : '播放');
}

function clearOutput() {
  elAudio.pause();
  elAudio.removeAttribute('src');
  elAudio.load();
  if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = ''; }
  state.pcm = null;
  state.peaks = null;
  state.duration = 0;
  state.progress = 0;
  elPlayBtn.disabled = true;
  elDlBtn.hidden = true;
  elWaveEmpty.hidden = false;
  elTimeCur.textContent = '0:00';
  elTimeTot.textContent = '0:00';
  drawWave(0);
}

function finishAudio(pcm, sr, opts) {
  if (!pcm || !pcm.length) return;
  state.pcm = pcm;
  state.sr = sr;
  state.duration = pcm.length / sr;
  state.peaks = computePeaks(pcm, 180);

  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  const blob = pcmToWav(pcm, sr);
  const url = URL.createObjectURL(blob);
  state.objectUrl = url;

  elAudio.src = url;
  elAudio.load();
  elDlBtn.href = url;
  elDlBtn.download = `breeze-${fileStamp()}.wav`;
  elDlBtn.hidden = false;
  elPlayBtn.disabled = false;
  elWaveEmpty.hidden = true;
  elTimeTot.textContent = fmtTime(state.duration);
  elTimeCur.textContent = '0:00';
  drawWave(0);

  if (opts && opts.autoplay) elAudio.play().catch(() => {});
}

function pcmToWav(pcm, sampleRate) {
  const dataLen = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataLen, true);
  new Uint8Array(buf, 44).set(new Uint8Array(pcm.buffer, pcm.byteOffset, dataLen));
  return new Blob([buf], { type: 'audio/wav' });
}

function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ================= 9. 音色库 ================= */

const META_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

function matches(v, q) {
  if (!q) return true;
  const hay = [v.id, v.description, v.ref_text]
    .concat(Object.entries(v.metadata || {}).map(([k, val]) => `${k} ${val}`))
    .join('\n')
    .toLowerCase();
  return hay.includes(q);
}

function renderLibrary() {
  if (!elVoiceGrid) return;
  const q = elLibFilter.value.trim().toLowerCase();
  const list = state.voices.filter((v) => matches(v, q));
  elVoiceGrid.textContent = '';
  elLibCount.textContent = !state.voices.length
    ? '暂无音色，可在克隆 / 引导 / 变声页保存一个'
    : list.length === state.voices.length
      ? `${state.voices.length} 个音色`
      : `${list.length} / ${state.voices.length} 个音色`;
  list.forEach((v) => elVoiceGrid.appendChild(voiceCard(v)));
}

elLibFilter.addEventListener('input', renderLibrary);
elLibRefresh.addEventListener('click', loadVoices);

function makeEl(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buttonEl(cls, text, title) {
  const b = makeEl('button', cls, text);
  if (title) b.title = title;
  return b;
}

function voiceCard(v) {
  const card = makeEl('div', 'vcard');
  const head = makeEl('div', 'vhead');
  head.appendChild(makeEl('span', 'vname', v.id));
  head.appendChild(makeEl('span', 'vtag', `${v.seconds.toFixed(1)}s`));
  head.appendChild(makeEl('span', 'vtag' + (v.saved ? '' : ' temp'), v.saved ? '已保存' : '临时'));

  const useBtn = buttonEl('ghost', '使用', '在克隆页使用此音色');
  useBtn.addEventListener('click', () => useVoice(v.id));
  head.appendChild(useBtn);

  const delBtn = buttonEl('ghost danger', '删除', '删除此音色');
  let armed = false;
  let timer = 0;
  delBtn.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      delBtn.textContent = '确认删除';
      timer = setTimeout(() => {
        armed = false;
        delBtn.textContent = '删除';
      }, 3000);
      return;
    }
    clearTimeout(timer);
    delBtn.disabled = true;
    try {
      const res = await fetch(state.base + '/v1/voices/' + encodeURIComponent(v.id), { method: 'DELETE' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      toast(`已删除音色 ${v.id}`, 'ok');
      await loadVoices();
    } catch (err) {
      toast('删除失败：' + err.message, 'err');
      delBtn.disabled = false;
    }
  });
  head.appendChild(delBtn);

  card.appendChild(head);

  if (v.ref_text) card.appendChild(makeEl('p', 'vtext', v.ref_text));

  const descLabel = makeEl('label', 'field');
  descLabel.appendChild(makeEl('span', 'flabel', '描述'));
  const desc = makeEl('textarea');
  desc.rows = 2;
  desc.maxLength = 4096;
  desc.placeholder = '这个音色的特点、来源与适用场景';
  desc.value = v.description || '';
  descLabel.appendChild(desc);
  card.appendChild(descLabel);

  card.appendChild(makeEl('span', 'flabel', '附加字段'));
  const box = makeEl('div', 'vfields');
  card.appendChild(box);

  const actions = makeEl('div', 'vactions');
  const addBtn = buttonEl('ghost', '+ 字段');
  const saveBtn = buttonEl('btn-quiet', '保存修改');
  const status = makeEl('span', 'vstatus', v.saved ? '' : '临时音色的备注会在服务重启后丢失');
  actions.append(addBtn, saveBtn, status);
  card.appendChild(actions);

  const collect = () => {
    const metadata = {};
    let bad = '';
    box.querySelectorAll('.vfield').forEach((row) => {
      const fields = row.querySelectorAll('input');
      const key = fields[0].value.trim();
      const val = fields[1].value;
      if (!key && !val.trim()) return;
      if (!META_KEY.test(key) || key === 'description') bad = bad || key || '（空）';
      else metadata[key] = val;
    });
    return { description: desc.value, metadata, bad };
  };

  const markDirty = () => {
    const c = collect();
    const before = v.metadata || {};
    const same = c.description === (v.description || '')
      && Object.keys(c.metadata).length === Object.keys(before).length
      && Object.keys(c.metadata).every((k) => before[k] === c.metadata[k]);
    card.classList.toggle('dirty', !same);
    saveBtn.disabled = same;
    if (!same) {
      status.classList.remove('err');
      status.textContent = '有未保存的修改';
    } else if (status.textContent === '有未保存的修改') {
      status.textContent = '';
    }
  };

  const addRow = (key, value) => {
    const row = makeEl('div', 'vfield');
    const k = makeEl('input');
    k.type = 'text';
    k.placeholder = '字段';
    k.value = key;
    const val = makeEl('input');
    val.type = 'text';
    val.placeholder = '值';
    val.value = value;
    const rm = buttonEl('ghost', '×', '删除字段');
    rm.addEventListener('click', () => { row.remove(); markDirty(); });
    k.addEventListener('input', markDirty);
    val.addEventListener('input', markDirty);
    row.append(k, val, rm);
    box.appendChild(row);
    return row;
  };

  for (const [k, val] of Object.entries(v.metadata || {})) addRow(k, val);

  addBtn.addEventListener('click', () => {
    const row = addRow('', '');
    row.querySelector('input').focus();
  });
  desc.addEventListener('input', markDirty);

  saveBtn.disabled = true;
  saveBtn.addEventListener('click', async () => {
    const c = collect();
    if (c.bad) {
      status.classList.add('err');
      status.textContent = '字段名只能包含字母、数字、点、连字符或下划线：' + c.bad;
      return;
    }
    const metadata = Object.assign({}, c.metadata);
    for (const k of Object.keys(v.metadata || {})) if (!(k in metadata)) metadata[k] = null;
    saveBtn.disabled = true;
    status.classList.remove('err');
    status.textContent = '正在保存…';
    try {
      const res = await fetch(state.base + '/v1/voices/' + encodeURIComponent(v.id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: c.description, metadata })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
      Object.assign(v, body);
      markDirty();
      status.textContent = v.saved ? '已保存' : '已更新（服务重启前有效）';
      $$('select[data-voice]').forEach((sel) => {
        const opt = Array.from(sel.options).find((o) => o.value === v.id);
        if (opt) opt.title = v.description || '';
        if (sel.value === v.id) syncVoice(sel.dataset.voice);
      });
    } catch (err) {
      status.classList.add('err');
      status.textContent = '出错：' + err.message;
      saveBtn.disabled = false;
    }
  });

  card.dataset.id = v.id;
  return card;
}

function useVoice(id) {
  $$('select[data-voice]').forEach((sel) => { sel.value = id; syncVoice(sel.dataset.voice); });
  switchPanel('clone');
  toast(`已载入音色：${id}`, 'ok');
}

/* ================= 10. 杂项 ================= */

function textOf(sel) {
  const node = $(sel);
  return node ? (node.value || '').trim() : '';
}

function numOf(sel, fallback) {
  const node = $(sel);
  if (!node) return fallback;
  const n = Number(node.value);
  return Number.isFinite(n) ? n : fallback;
}

function fileOf(sel) {
  const node = $(sel);
  return node && node.files && node.files[0] ? node.files[0] : null;
}

function setStatus(text, kind) {
  elStatusPill.textContent = text;
  elStatusPill.dataset.state = kind || 'idle';
}

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00';
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function toast(message, kind) {
  const node = makeEl('div', 'toast' + (kind ? ' ' + kind : ''), message);
  elToasts.appendChild(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 260);
  }, 3200);
}

/* 流式开关 / 缓冲 */
elBufRange.addEventListener('input', () => {
  elBufVal.textContent = Number(elBufRange.value).toFixed(2) + 's';
});
elStreamToggle.addEventListener('change', () => {
  elBufRange.disabled = !elStreamToggle.checked;
});
elBufRange.disabled = !elStreamToggle.checked;

/* 初始 */
elBufVal.textContent = Number(elBufRange.value).toFixed(2) + 's';
setStatus('待命', 'idle');
drawWave(0);
