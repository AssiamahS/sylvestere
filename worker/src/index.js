// Sylvestere API — tutor brain for the Sylvestere web + iOS app.
// Runs on Cloudflare Workers AI (free daily allowance), falls back to OpenRouter if a key is set.

const MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-3.1-8b-instruct',
];

const ALLOWED_ORIGINS = [
  'https://assiamahs.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

const LANG_NAMES = { tw: 'Twi (Akan, Ghana)', fr: 'French', es: 'Spanish', pt: 'Portuguese', de: 'German', it: 'Italian', ar: 'Arabic', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', hi: 'Hindi' };

const LEVEL_HINT = {
  beginner: 'Use very simple words and short sentences (A1-A2). Speak slowly in spirit: max 2 short sentences per turn.',
  intermediate: 'Use everyday natural English (B1-B2). Max 3 sentences per turn.',
  advanced: 'Use rich, idiomatic, native-level English (C1). Max 3 sentences per turn, and push the learner with follow-up questions.',
};

const SCENARIOS = {
  cafe: 'You are a barista and the learner is ordering at a busy cafe in New York. Start by greeting them and asking what they would like.',
  interview: 'You are a hiring manager interviewing the learner for a job they want. Start by welcoming them and asking them to introduce themselves.',
  airport: 'You are an airline check-in agent. The learner is flying to London. Start by asking for their passport and destination.',
  doctor: 'You are a friendly doctor. The learner has come in with a cold. Start by asking what brings them in today.',
  smalltalk: 'You and the learner are meeting at a friend\'s party. Start with casual small talk about how they know the host.',
  hotel: 'You are a hotel receptionist. The learner is checking in after a long flight. Start by welcoming them and asking for their name.',
};

function corsHeaders(origin) {
  const ok = !origin || ALLOWED_ORIGINS.includes(origin) || origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': ok ? (origin || '*') : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(data, status, extra) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

function systemPrompt({ scenario, level, native, tutor }) {
  const scene = SCENARIOS[scenario] || SCENARIOS.cafe;
  const lvl = LEVEL_HINT[level] || LEVEL_HINT.intermediate;
  const nat = native && native !== 'en' ? native : null;
  return [
    `You are ${tutor || 'Sylvie'}, a warm, encouraging English conversation tutor inside a language-learning app.`,
    `Role-play: ${scene}`,
    `Learner level: ${level || 'intermediate'}. ${lvl}`,
    `Stay in character and keep the conversation moving with a question at the end of most turns.`,
    `When the learner makes a grammar, vocabulary or word-order mistake, gently correct it: give the corrected sentence and a one-line tip. If their sentence is fine, leave "correction" empty.`,
    `Always leave "translation" as an empty string (the app translates separately).`,
    `After about 8 exchanges, wrap the scene up naturally and set "done" to true.`,
    `Reply ONLY with a JSON object, no markdown, no prose outside JSON:`,
    `{"reply": "<what you say to the learner, in English>", "translation": "<reply translated to the learner's language, or empty string>", "correction": "<corrected version of the learner's last sentence, or empty string>", "tip": "<one short tip about the mistake, or empty string>", "done": false}`,
  ].join('\n');
}

function extractJSON(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

function normalize(obj, raw) {
  if (!obj || typeof obj !== 'object') {
    return { reply: String(raw || '').trim().slice(0, 600), translation: '', correction: '', tip: '', done: false };
  }
  return {
    reply: String(obj.reply || obj.response || '').trim(),
    translation: String(obj.translation || '').trim(),
    correction: String(obj.correction || '').trim(),
    tip: String(obj.tip || '').trim(),
    done: Boolean(obj.done),
  };
}

async function runWorkersAI(env, messages) {
  let lastErr;
  for (const model of MODELS) {
    try {
      const out = await env.AI.run(model, { messages, max_tokens: 400, temperature: 0.7 });
      let text = typeof out === 'string' ? out : (out.response ?? out.result?.response ?? '');
      // Workers AI sometimes hands back the model's JSON already parsed.
      const parsed = (text && typeof text === 'object') ? text : extractJSON(text);
      if (typeof text === 'object') text = JSON.stringify(text);
      if (parsed && parsed.reply) return { data: normalize(parsed, text), model };
      if (text) return { data: normalize(null, text), model };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Workers AI returned nothing');
}

async function runOpenRouter(env, messages) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://assiamahs.github.io/sylvestere/',
      'X-Title': 'Sylvestere',
    },
    body: JSON.stringify({
      model: env.OPENROUTER_MODEL || 'google/gemma-4-31b-it:free',
      messages,
      max_tokens: 400,
      temperature: 0.7,
      reasoning: { exclude: true },
    }),
  });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error?.message || `OpenRouter ${r.status}`);
  const text = d.choices?.[0]?.message?.content || '';
  return { data: normalize(extractJSON(text), text), model: d.model || 'openrouter' };
}

// ---- Mac relay: the user's own Claude Code (Max subscription) dials OUT to this DO and answers turns.
export class Brain {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.pending = new Map();
  }

  macSockets() {
    return this.state.getWebSockets('mac').filter((ws) => ws.readyState === 1);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/mac') {
      if (!this.env.MAC_TOKEN || url.searchParams.get('token') !== this.env.MAC_TOKEN) return new Response('forbidden', { status: 403 });
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1], ['mac']);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === '/status') {
      return json({ mac: this.macSockets().length, pending: this.pending.size }, 200, {});
    }
    if (url.pathname === '/ask' && request.method === 'POST') {
      const macs = this.macSockets();
      if (!macs.length) return json({ error: 'mac offline' }, 503, {});
      const body = await request.json();
      const id = crypto.randomUUID();
      const text = await new Promise((resolve) => {
        const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, 45000);
        this.pending.set(id, { resolve, timer });
        try { macs[0].send(JSON.stringify({ id, system: body.system, messages: body.messages })); }
        catch (e) { clearTimeout(timer); this.pending.delete(id); resolve(null); }
      });
      if (text == null) return json({ error: 'mac timeout' }, 504, {});
      return json({ text }, 200, {});
    }
    return new Response('not found', { status: 404 });
  }

  webSocketMessage(ws, msg) {
    let d;
    try { d = JSON.parse(typeof msg === 'string' ? msg : new TextDecoder().decode(msg)); } catch { return; }
    if (d.type === 'ping') { try { ws.send(JSON.stringify({ type: 'pong' })); } catch {} return; }
    const p = d.id && this.pending.get(d.id);
    if (p) { clearTimeout(p.timer); this.pending.delete(d.id); p.resolve(String(d.text ?? '')); }
  }

  webSocketClose(ws) { try { ws.close(); } catch {} }
  webSocketError(ws) { try { ws.close(); } catch {} }
}

async function runMac(env, messages) {
  const stub = env.BRAIN.get(env.BRAIN.idFromName('main'));
  const system = messages[0].content;
  const r = await stub.fetch('https://brain/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system, messages: messages.slice(1) }),
  });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error || `relay ${r.status}`);
  return { data: normalize(extractJSON(d.text), d.text), model: 'claude (mac)' };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/mac' || url.pathname === '/status') {
      const stub = env.BRAIN.get(env.BRAIN.idFromName('main'));
      return stub.fetch(request);
    }
    if (url.pathname === '/health') return json({ ok: true, models: MODELS }, 200, cors);
    if (url.pathname === '/translate' && request.method === 'POST') {
      let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400, cors); }
      const text = String(b.text || '').slice(0, 1000); const to = String(b.to || '').slice(0, 5);
      if (!text || !to || to === 'en') return json({ text: '' }, 200, cors);
      try {
        const out = await env.AI.run('@cf/meta/m2m100-1.2b', { text, source_lang: 'en', target_lang: to });
        return json({ text: String(out.translated_text || '').trim() }, 200, cors);
      } catch (e) {
        // Language not in m2m100 (e.g. Twi): ask the LLM instead.
        try {
          const name = LANG_NAMES[to] || to;
          const out = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
            messages: [
              { role: 'system', content: `Translate the user's English text into ${name}. Reply with the translation only, nothing else.` },
              { role: 'user', content: text },
            ], max_tokens: 300, temperature: 0.2,
          });
          const t = typeof out === 'string' ? out : (out.response || '');
          return json({ text: String(t).trim() }, 200, cors);
        } catch (e2) { return json({ error: `translate failed: ${e.message}; ${e2.message}` }, 502, cors); }
      }
    }
    if (url.pathname === '/stt' && request.method === 'POST') {
      // Speech-to-text fallback for browsers without a working Web Speech API (Chromium forks, WKWebView).
      const buf = await request.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > 8 * 1024 * 1024) return json({ error: 'bad audio' }, 400, cors);
      try {
        const out = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
          audio: btoa(String.fromCharCode(...new Uint8Array(buf))),
          language: 'en',
          task: 'transcribe',
        });
        return json({ text: String(out.text || '').trim() }, 200, cors);
      } catch (e) {
        try {
          const out = await env.AI.run('@cf/openai/whisper', { audio: [...new Uint8Array(buf)] });
          return json({ text: String(out.text || '').trim() }, 200, cors);
        } catch (e2) {
          return json({ error: `stt failed: ${e.message}; ${e2.message}` }, 502, cors);
        }
      }
    }
    if (url.pathname !== '/chat' || request.method !== 'POST') return json({ error: 'not found' }, 404, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400, cors); }

    const history = Array.isArray(body.history) ? body.history.slice(-14) : [];
    const messages = [{ role: 'system', content: systemPrompt(body) }];
    for (const m of history) {
      if (!m || !m.content) continue;
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 1200) });
    }
    if (!history.length) {
      messages.push({ role: 'user', content: '[The learner has just joined. Open the scene with your first line.]' });
    }

    if (env.MAC_TOKEN && body.brain !== 'cloud') {
      try {
        const { data, model } = await runMac(env, messages);
        if (data.reply) return json({ ...data, model }, 200, cors);
      } catch (e) {
        // Mac asleep or slow: fall through to Workers AI.
      }
    }
    try {
      const { data, model } = await runWorkersAI(env, messages);
      return json({ ...data, model }, 200, cors);
    } catch (e) {
      if (env.OPENROUTER_API_KEY) {
        try {
          const { data, model } = await runOpenRouter(env, messages);
          return json({ ...data, model }, 200, cors);
        } catch (e2) {
          return json({ error: `ai failed: ${e.message}; openrouter: ${e2.message}` }, 502, cors);
        }
      }
      return json({ error: `ai failed: ${e.message}` }, 502, cors);
    }
  },
};
