import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

// ---------- config ----------
const API = localStorage.getItem('sly_api') || 'https://sylvestere-api.sylvesterassiamahpm.workers.dev';
const TUTOR = 'Sylvie';
const GOAL_TURNS = 8;
const $ = (id) => document.getElementById(id);

const NATIVE_LANG_TAG = {
  fr: 'fr-FR', es: 'es-ES', pt: 'pt-BR', de: 'de-DE', it: 'it-IT', ar: 'ar-SA',
  zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR', hi: 'hi-IN', tw: 'en-US', en: 'en-US',
};

// ---------- native bridge (iOS WKWebView) ----------
const native = window.webkit?.messageHandlers?.sly ? {
  post(msg) { window.webkit.messageHandlers.sly.postMessage(msg); },
} : null;
const bridge = { onSpeech: null, onSpeak: null };
window.__sly = {
  onSpeech(e) { bridge.onSpeech && bridge.onSpeech(e); },
  onSpeak(e) { bridge.onSpeak && bridge.onSpeak(e); },
};

// ---------- speech: TTS ----------
const tts = {
  voice: null,
  speaking: false,
  pickVoice() {
    if (native) return;
    const vs = speechSynthesis.getVoices();
    if (!vs.length) return;
    const en = vs.filter(v => /^en[-_]/i.test(v.lang));
    const prefer = ['Samantha', 'Ava', 'Allison', 'Zoe', 'Google US English', 'Microsoft Aria', 'Microsoft Jenny', 'Karen', 'Moira'];
    const local = en.filter(v => v.localService);
    this.voice = local.find(v => prefer.some(p => v.name.includes(p)) && /premium|enhanced/i.test(v.name))
      || local.find(v => prefer.some(p => v.name.includes(p)))
      || en.find(v => prefer.some(p => v.name.includes(p)))
      || local.find(v => v.lang === 'en-US') || en.find(v => v.lang === 'en-US') || en[0] || vs[0];
  },
  speak(text, { onStart, onEnd, onWord } = {}) {
    this.stop();
    if (!text) { onEnd && onEnd(); return; }
    if (native) {
      bridge.onSpeak = (e) => {
        if (e.state === 'start') { this.speaking = true; onStart && onStart(); }
        else if (e.state === 'word') { onWord && onWord(); }
        else if (e.state === 'end' || e.state === 'cancel') { this.speaking = false; bridge.onSpeak = null; onEnd && onEnd(); }
      };
      native.post({ type: 'speak', text, lang: 'en-US' });
      return;
    }
    if (!('speechSynthesis' in window)) { onStart && onStart(); setTimeout(() => onEnd && onEnd(), Math.min(6000, 60 * text.length)); return; }
    const u = new SpeechSynthesisUtterance(text);
    if (!this.voice) this.pickVoice();
    if (this.voice) u.voice = this.voice;
    u.lang = 'en-US'; u.rate = 0.98; u.pitch = 1.05;
    let ended = false;
    const finish = () => { if (ended) return; ended = true; this.speaking = false; onEnd && onEnd(); };
    u.onstart = () => { this.speaking = true; onStart && onStart(); };
    u.onboundary = (ev) => { if (!ev.name || ev.name === 'word') onWord && onWord(); };
    u.onend = finish; u.onerror = finish;
    // Safari sometimes never fires onend; guard with a timer.
    setTimeout(finish, 1500 + text.length * 90);
    speechSynthesis.speak(u);
  },
  stop() {
    if (native) { native.post({ type: 'stopSpeak' }); }
    else if ('speechSynthesis' in window) speechSynthesis.cancel();
    this.speaking = false;
  },
};
if (!native && 'speechSynthesis' in window) {
  tts.pickVoice();
  speechSynthesis.onvoiceschanged = () => tts.pickVoice();
}

// ---------- speech: STT ----------
// Native bridge on iOS; otherwise the browser's SpeechRecognition AND a MediaRecorder run together.
// If recognition never answers (Chromium forks without Google's speech keys, e.g. Dia/Brave) the
// recording goes to the worker's Whisper endpoint instead.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const REC_MIME = (window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) ? 'audio/webm;codecs=opus' : null;
const canRecord = () => Boolean(REC_MIME && navigator.mediaDevices?.getUserMedia);

const stt = {
  rec: null, media: null, stream: null, ctx: null, active: false, settled: false, chunks: [], heardSpeech: false, timers: [], recPending: false, srError: null,
  get available() { return Boolean(native || SR || canRecord()); },

  start(cb) {
    this.stop();
    this.active = true; this.settled = false; this.chunks = []; this.heardSpeech = false; this.srError = null; this.recPending = false; this.recUsed = false;
    if (native) return this.startNative(cb);
    if (!SR && !canRecord()) { cb.onError && cb.onError('no-stt'); cb.onEnd && cb.onEnd(); return; }
    if (canRecord()) this.startRecorder(cb);
    if (SR) this.startSR(cb);
  },

  startNative(cb) {
    bridge.onSpeech = (e) => {
      if (e.state === 'partial') cb.onPartial && cb.onPartial(e.text || '');
      else if (e.state === 'final') { this.active = false; bridge.onSpeech = null; cb.onFinal && cb.onFinal(e.text || ''); cb.onEnd && cb.onEnd(); }
      else if (e.state === 'error') { this.active = false; bridge.onSpeech = null; cb.onError && cb.onError(e.message || 'speech error'); cb.onEnd && cb.onEnd(); }
    };
    native.post({ type: 'listen', lang: 'en-US' });
  },

  startSR(cb) {
    const r = new SR();
    r.lang = 'en-US'; r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
    let finalText = '';
    r.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalText += t; else interim += t;
      }
      this.heardSpeech = true;
      cb.onPartial && cb.onPartial((finalText + ' ' + interim).trim());
    };
    r.onerror = (ev) => { this.srError = ev.error; };
    r.onend = () => {
      this.rec = null;
      if (finalText.trim()) return this.settle(cb, finalText.trim());
      // Recognition gave nothing (Chromium forks fail fast): keep recording, the silence
      // detector will stop it and the audio goes to Whisper.
      if (this.media || this.recPending || this.recUsed) return; // recorder path will settle
      this.settle(cb, '', this.srError);
    };
    this.rec = r;
    try { r.start(); } catch (e) { this.rec = null; if (!this.media) this.settle(cb, '', String(e)); }
  },

  async startRecorder(cb) {
    this.recPending = true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      this.stream = null; this.recPending = false;
      if (!this.rec) this.settle(cb, '', 'not-allowed');
      return;
    }
    this.recPending = false;
    if (!this.active || this.settled) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; return; }
    const media = new MediaRecorder(this.stream, { mimeType: REC_MIME });
    media.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    media.onstop = async () => {
      this.releaseMic();
      if (this.settled) return;
      const blob = new Blob(this.chunks, { type: 'audio/webm' });
      if (!this.heardSpeech || blob.size < 2000) return this.settle(cb, '', this.srError);
      setStatus('Transcribing…');
      try {
        const r = await fetch(`${API}/stt`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
        const d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
        this.settle(cb, (d.text || '').trim());
      } catch (e) { this.settle(cb, '', `transcription failed: ${e.message}`); }
    };
    this.media = media; this.recUsed = true;
    media.start(250);
    if (!this.rec) cb.onPartial && cb.onPartial('');

    // Energy-based end-of-speech: 1.5 s of silence after speech, 8 s with no speech at all, 20 s hard cap.
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = this.ctx.createMediaStreamSource(this.stream);
      const an = this.ctx.createAnalyser(); an.fftSize = 1024; src.connect(an);
      const buf = new Float32Array(an.fftSize);
      let lastVoice = 0; const t0 = performance.now();
      const tick = () => {
        if (!this.media || this.media.state !== 'recording') return;
        an.getFloatTimeDomainData(buf);
        let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const now = performance.now();
        if (rms > 0.02) { lastVoice = now; if (!this.heardSpeech) { this.heardSpeech = true; if (!this.rec) cb.onPartial && cb.onPartial('(listening…)'); } }
        if ((this.heardSpeech && now - lastVoice > 1500) || (!this.heardSpeech && now - t0 > 8000) || now - t0 > 20000) { this.stopAll(); return; }
        this.timers.push(setTimeout(tick, 100));
      };
      tick();
    } catch (e) { this.timers.push(setTimeout(() => this.stopAll(), 12000)); }
  },

  stopRecorder() { if (this.media && this.media.state !== 'inactive') { try { this.media.stop(); } catch {} } },
  releaseMic() {
    this.timers.forEach(clearTimeout); this.timers = [];
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    if (this.ctx) { try { this.ctx.close(); } catch {} this.ctx = null; }
    this.media = null;
  },
  stopAll() {
    if (this.rec) { try { this.rec.stop(); } catch {} }
    this.stopRecorder();
  },
  settle(cb, text, err) {
    if (this.settled) return;
    this.settled = true; this.active = false;
    if (this.rec) { try { this.rec.abort(); } catch {} this.rec = null; }
    this.releaseMic();
    if (!text && err) cb.onError && cb.onError(err);
    cb.onFinal && cb.onFinal(text);
    cb.onEnd && cb.onEnd();
  },
  stop() {
    if (!this.active) return;
    if (native) { native.post({ type: 'stopListen' }); return; }
    this.stopAll();
  },
};

window.__stt = stt;

// ---------- 3D avatar ----------
const avatar = {
  vrm: null, clock: new THREE.Clock(), talking: false, wordPulse: 0, blinkT: 1.5, mood: 0, wordSeen: false, lastWord: 0,
  async init() {
    const canvas = $('stage');
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.05, 30);
    const key = new THREE.DirectionalLight(0xfff1e0, 2.2); key.position.set(1, 2, 2);
    const fill = new THREE.DirectionalLight(0xc9b8ff, 0.9); fill.position.set(-2, 1, 1);
    const rim = new THREE.DirectionalLight(0xffb070, 1.2); rim.position.set(0, 2, -2);
    this.scene.add(key, fill, rim, new THREE.AmbientLight(0xffffff, 0.9));

    const loader = new GLTFLoader();
    loader.register((p) => new VRMLoaderPlugin(p));
    const gltf = await loader.loadAsync('assets/avatar.vrm', (ev) => {
      if (ev.total) $('loadingText').textContent = `Loading ${TUTOR}… ${Math.round(ev.loaded / ev.total * 100)}%`;
    });
    const vrm = gltf.userData.vrm;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons?.(gltf.scene);
    VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse((o) => { o.frustumCulled = false; });
    this.scene.add(vrm.scene);
    this.vrm = vrm;
    if (vrm.lookAt) vrm.lookAt.target = this.camera;

    // relax the T-pose
    const h = vrm.humanoid;
    const set = (name, x, y, z) => { const b = h.getNormalizedBoneNode(name); if (b) b.rotation.set(x, y, z); };
    set('leftUpperArm', 0, 0, -1.15); set('rightUpperArm', 0, 0, 1.15);
    set('leftLowerArm', 0, 0, -0.25); set('rightLowerArm', 0, 0, 0.25);

    this.resize();
    addEventListener('resize', () => this.resize());
    this.frame();
    this.renderer.setAnimationLoop(() => this.tick());
  },
  frame() {
    const head = this.vrm.humanoid.getNormalizedBoneNode('head');
    const p = new THREE.Vector3(); head.getWorldPosition(p);
    const portrait = innerHeight > innerWidth;
    const dist = portrait ? 1.05 : 0.85;
    this.camera.position.set(0, p.y + 0.02, dist);
    this.camera.lookAt(0, p.y - (portrait ? 0.10 : 0.04), 0);
  },
  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    if (this.vrm) this.frame();
  },
  expr(name, v) {
    const em = this.vrm?.expressionManager; if (!em || em.getExpression(name) == null) return;
    em.setValue(name, THREE.MathUtils.clamp(v, 0, 1));
  },
  tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    const vrm = this.vrm; if (!vrm) return;
    const h = vrm.humanoid;
    // idle: breathing + gentle sway + head nod while talking
    const spine = h.getNormalizedBoneNode('spine'); if (spine) spine.rotation.z = Math.sin(t * 0.6) * 0.015;
    const chest = h.getNormalizedBoneNode('chest'); if (chest) chest.rotation.x = Math.sin(t * 1.6) * 0.012;
    const neck = h.getNormalizedBoneNode('neck');
    if (neck) {
      const talkNod = this.talking ? Math.sin(t * 5.5) * 0.04 + this.wordPulse * 0.05 : 0;
      neck.rotation.x = Math.sin(t * 0.8) * 0.02 + talkNod;
      neck.rotation.z = Math.sin(t * 0.5) * 0.02;
      neck.rotation.y = Math.sin(t * 0.35) * 0.04;
    }
    // blink
    this.blinkT -= dt;
    let blink = 0;
    if (this.blinkT < 0.16) blink = Math.sin(Math.max(0, this.blinkT) / 0.16 * Math.PI);
    if (this.blinkT <= 0) this.blinkT = 2.2 + Math.random() * 3.5;
    this.expr('blink', blink);
    // mouth
    this.wordPulse = Math.max(0, this.wordPulse - dt * 5);
    // With word-boundary events the mouth closes between words/pauses; without them, a steady babble.
    const sinceWord = performance.now() - this.lastWord;
    const mouthOpen = this.talking && (!this.wordSeen || sinceWord < 420);
    if (mouthOpen) {
      const gate = this.wordSeen ? Math.max(0.35, 1 - sinceWord / 420) : 1;
      const env = (0.3 + 0.7 * Math.abs(Math.sin(t * 9.5)) * (0.6 + 0.4 * Math.sin(t * 2.3 + 1)) + this.wordPulse * 0.35) * gate;
      this.expr('aa', env * 0.8);
      this.expr('ih', Math.max(0, Math.sin(t * 6.1)) * 0.22 * gate);
      this.expr('oh', Math.max(0, Math.sin(t * 4.3 + 2)) * 0.28 * gate);
      this.expr('happy', 0.15);
    } else {
      this.expr('aa', 0); this.expr('ih', 0); this.expr('oh', 0);
      this.expr('happy', 0.25 + this.mood * 0.5);
    }
    vrm.update(dt);
    this.renderer.render(this.scene, this.camera);
  },
};

// ---------- session state ----------
const state = {
  scenario: 'cafe', level: 'intermediate', native: 'fr',
  history: [], turns: 0, busy: false, corrections: [], lastReply: '',
};

function setStatus(s) { $('status').textContent = s || ''; }
function setProgress() {
  $('progressFill').style.width = `${Math.min(100, state.turns / GOAL_TURNS * 100)}%`;
  $('turnLabel').textContent = `${Math.min(state.turns, GOAL_TURNS)}/${GOAL_TURNS}`;
}
function showBubble(data, heardText) {
  $('replyText').textContent = data.reply;
  const tx = $('txText'), tg = $('toggleTx');
  tx.classList.add('hidden'); tg.textContent = '👁 See translation';
  if (state.native !== 'en') {
    tg.classList.remove('hidden');
    if (data.translation) tx.textContent = data.translation;
    else { tx.textContent = 'Translating…'; translate(data.reply, state.native).then((t) => { if ($('replyText').textContent === data.reply) tx.textContent = t || 'Translation unavailable'; }); }
  } else tg.classList.add('hidden');
  const c = $('correction');
  if (data.correction && heardText && data.correction.trim().toLowerCase() !== heardText.trim().toLowerCase()) {
    $('corrText').textContent = data.correction; $('tipText').textContent = data.tip || '';
    c.classList.remove('hidden');
    state.corrections.push({ said: heardText, better: data.correction, tip: data.tip || '' });
  } else c.classList.add('hidden');
  $('bubble').classList.remove('hidden');
}
async function translate(text, to) {
  try {
    const r = await fetch(`${API}/translate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, to }) });
    const d = await r.json(); return d.text || '';
  } catch { return ''; }
}
function say(text, after) {
  avatar.talking = false; avatar.wordSeen = false;
  tts.speak(text, {
    onStart: () => { avatar.talking = true; avatar.lastWord = performance.now(); },
    onWord: () => { avatar.wordSeen = true; avatar.wordPulse = 1; avatar.lastWord = performance.now(); },
    onEnd: () => { avatar.talking = false; after && after(); },
  });
}
function setBusy(b) {
  state.busy = b;
  $('micBtn').disabled = b; $('typeBtn').disabled = b; $('nextBtn').disabled = b;
}

async function askTutor(userText) {
  if (userText) state.history.push({ role: 'user', content: userText });
  setBusy(true); setStatus(`${TUTOR} is thinking…`);
  let data;
  try {
    const r = await fetch(`${API}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: state.scenario, level: state.level, native: state.native, tutor: TUTOR, history: state.history }),
    });
    data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
  } catch (e) {
    setStatus(`Connection problem: ${e.message}`);
    setBusy(false);
    if (userText) state.history.pop();
    return;
  }
  state.history.push({ role: 'assistant', content: data.reply });
  state.lastReply = data.reply;
  if (userText) { state.turns++; setProgress(); }
  showBubble(data, userText);
  setStatus('');
  say(data.reply, () => {
    setBusy(false);
    if (data.done || state.turns >= GOAL_TURNS) return finish();
    setStatus(stt.available ? 'Tap the mic and answer in English' : 'Type your answer in English');
  });
}

function startListening() {
  if (state.busy || stt.active) { stt.stop(); return; }
  tts.stop(); avatar.talking = false;
  const mic = $('micBtn'); mic.classList.add('listening');
  $('heard').classList.remove('hidden'); $('heardText').textContent = '…';
  setStatus('Listening… speak, then pause (or tap again)');
  stt.start({
    onPartial: (t) => { $('heardText').textContent = t || '…'; },
    onError: (err) => {
      mic.classList.remove('listening');
      if (err === 'not-allowed' || err === 'service-not-allowed' || err === 'audio-capture') setStatus('Microphone blocked. Allow the mic, or use the keyboard.');
      else if (err === 'no-stt') { setStatus('Speech recognition is not available in this browser. Use the keyboard.'); $('typeForm').classList.remove('hidden'); }
      else setStatus(`Did not catch that (${err}). Try again.`);
    },
    onFinal: (t) => {
      mic.classList.remove('listening');
      if (!t) { if (!$('status').textContent.startsWith('Did not')) setStatus('I did not hear anything. Try again.'); $('heard').classList.add('hidden'); return; }
      $('heardText').textContent = t;
      askTutor(t);
    },
  });
}

function finish() {
  tts.stop();
  $('session').classList.add('hidden'); $('top').classList.add('hidden');
  const n = state.corrections.length;
  $('doneSummary').textContent = n
    ? `You finished the ${labelFor(state.scenario)} scene with ${state.turns} replies. ${TUTOR} fixed ${n} sentence${n > 1 ? 's' : ''}:`
    : `You finished the ${labelFor(state.scenario)} scene with ${state.turns} replies and no corrections. Impressive.`;
  const box = $('doneCorrections'); box.innerHTML = '';
  for (const c of state.corrections) {
    const d = document.createElement('div');
    d.innerHTML = `<s></s> → <b></b><br><small></small>`;
    d.querySelector('s').textContent = c.said; d.querySelector('b').textContent = c.better; d.querySelector('small').textContent = c.tip;
    box.appendChild(d);
  }
  $('done').classList.remove('hidden');
}
function labelFor(v) { return $('scenarios').querySelector(`[data-v="${v}"]`)?.textContent.replace(/^\S+\s/, '') || v; }

function startSession() {
  state.history = []; state.turns = 0; state.corrections = []; state.lastReply = '';
  $('home').classList.add('hidden'); $('done').classList.add('hidden');
  $('bubble').classList.add('hidden'); $('heard').classList.add('hidden'); $('correction').classList.add('hidden');
  $('top').classList.remove('hidden'); $('session').classList.remove('hidden');
  setProgress();
  // iOS Safari needs a user-gesture-primed utterance before async TTS will play
  if (!native && 'speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(''); speechSynthesis.speak(u); }
  askTutor(null);
}
function endSession() {
  tts.stop(); stt.stop(); avatar.talking = false; setBusy(false);
  $('session').classList.add('hidden'); $('top').classList.add('hidden'); $('typeForm').classList.add('hidden');
  $('home').classList.remove('hidden');
}

// ---------- wiring ----------
function chipGroup(id, key) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $(id).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    state[key] = b.dataset.v;
  });
}
chipGroup('scenarios', 'scenario'); chipGroup('levels', 'level');
const nav = (navigator.language || 'fr').slice(0, 2).toLowerCase();
if ([...$('native').options].some(o => o.value === nav)) { $('native').value = nav; state.native = nav; }
$('native').addEventListener('change', (e) => { state.native = e.target.value; });
$('start').addEventListener('click', startSession);
$('again').addEventListener('click', () => { $('done').classList.add('hidden'); $('home').classList.remove('hidden'); });
$('close').addEventListener('click', endSession);
$('micBtn').addEventListener('click', startListening);
$('toggleTx').addEventListener('click', () => {
  const tx = $('txText'); const open = tx.classList.toggle('hidden');
  $('toggleTx').textContent = open ? '👁 See translation' : '🙈 Hide translation';
});
$('typeBtn').addEventListener('click', () => { $('typeForm').classList.toggle('hidden'); $('typeInput').focus(); });
$('typeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('typeInput').value.trim(); if (!t || state.busy) return;
  $('typeInput').value = ''; $('typeForm').classList.add('hidden');
  $('heard').classList.remove('hidden'); $('heardText').textContent = t;
  tts.stop(); avatar.talking = false;
  askTutor(t);
});
$('nextBtn').addEventListener('click', () => {
  if (state.busy) return;
  if (tts.speaking) { tts.stop(); avatar.talking = false; setBusy(false); setStatus('Your turn'); return; }
  $('heard').classList.add('hidden');
  askTutor("(I don't know what to say. Please give me an example sentence I could say here, then continue.)");
});
$('capNote').textContent = stt.available ? 'Uses your microphone. Works best in Safari on iPhone or Chrome.' : 'Speech recognition is unavailable in this browser: you can still type your answers.';

// ---------- boot ----------
(async () => {
  try {
    await avatar.init();
  } catch (e) {
    console.error(e);
    $('loadingText').textContent = `Could not load the avatar (${e.message}). Check your connection and reload.`;
    return;
  }
  $('loading').classList.add('hidden');
  $('home').classList.remove('hidden');
})();
