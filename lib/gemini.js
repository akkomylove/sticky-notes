const BASE = 'https://generativelanguage.googleapis.com/v1beta';

const PROMPT = require('./prompt');
const { parseJsonLoose } = require('./json');

async function apiFetch(key, pathName, init = {}) {
  const { query, headers, ...rest } = init;
  const url = `${BASE}${pathName}${query ? `${pathName.includes('?') ? '&' : '?'}${query}` : ''}`;
  const res = await fetch(url, {
    ...rest,
    redirect: 'error',
    headers: { 'x-goog-api-key': key, ...(headers || {}) },
    signal: rest.signal || AbortSignal.timeout(45000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (err) {
    body = null;
  }
  if (!res.ok) {
    const detail = body?.error?.message || text.slice(0, 300) || res.statusText;
    const err = new Error(`HTTP ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function listModels(key) {
  const out = [];
  let pageToken = '';
  for (let i = 0; i < 5; i += 1) {
    const query = `pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const data = await apiFetch(key, '/models', { query, method: 'GET' });
    for (const m of data?.models || []) {
      if ((m.supportedGenerationMethods || []).includes('generateContent')) out.push(m.name.replace(/^models\//, ''));
    }
    pageToken = data?.nextPageToken || '';
    if (!pageToken) break;
  }
  return out;
}

// 从当前可用模型中优先选择稳定版 Flash。
const FLASH_EXCLUDE = /embedding|rerank|image|tts|live|audio|a2a|deprec/i;
const FLASH_VARIANT = /lite|nano|exp|preview|custom|thinking/i;

function rankFlashModels(models) {
  const flash = models.filter((id) => /flash/i.test(id) && !FLASH_EXCLUDE.test(id));
  const pool = flash.filter((id) => !FLASH_VARIANT.test(id));
  const chosen = pool.length ? pool : flash;
  return chosen.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
}

async function resolveModel(key, preferred) {
  if (preferred) return preferred;
  const ranked = rankFlashModels(await listModels(key));
  if (!ranked.length) throw new Error('这个 key 下没有可用的 flash 文本模型');
  return ranked[0];
}

function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || '').join('');
}

async function understandScreenshot({ key, model, images }) {
  if (!key) throw new Error('还没有配置 Gemini API key');
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          ...images.map(({ mimeType, base64 }) => ({ inline_data: { mime_type: mimeType, data: base64 } })),
          { text: PROMPT },
        ],
      },
    ],
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
  };
  const data = await apiFetch(key, `/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = extractText(data);
  if (!raw) throw new Error(`模型返回为空（结束原因：${data?.candidates?.[0]?.finishReason || '未知'}）`);
  const parsed = parseJsonLoose(raw);
  return {
    task_name: String(parsed.task_name || '').trim(),
    summary: String(parsed.summary || '').trim(),
    points: Array.isArray(parsed.points) ? parsed.points.map(String) : [],
    due: parsed.due || null,
    from: parsed.from || null,
    model,
  };
}

module.exports = { listModels, rankFlashModels, resolveModel, understandScreenshot };
