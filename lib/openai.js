'use strict';

const PROMPT = require('./prompt');
const { parseJsonLoose } = require('./json');

function parseBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl || '').trim());
  } catch {
    throw new Error('请输入完整的 Base URL，例如 https://api.example.com/v1');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Base URL 必须使用 HTTPS。本机回环地址可用 HTTP');
  }
  if (url.username || url.password || url.href.includes('?') || url.href.includes('#')) {
    throw new Error('Base URL 不能包含登录信息、查询参数或片段');
  }
  return url;
}

function baseUrlOrigin(baseUrl) {
  try {
    return parseBaseUrl(baseUrl).origin;
  } catch {
    return null;
  }
}

// 支持 /v1、带末尾斜线的地址和已包含接口路径的地址。
function endpoints(baseUrl) {
  const url = parseBaseUrl(baseUrl);
  const pathname = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|models)$/i, '');
  const root = url.origin + pathname;
  return { root, chat: `${root}/chat/completions`, models: `${root}/models` };
}

async function call(url, key, init = {}) {
  const res = await fetch(url, {
    ...init,
    redirect: 'error',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: init.signal || AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (err) {
    body = null;
  }
  if (!res.ok) {
    const detail = body?.error?.message || body?.message || text.slice(0, 300) || res.statusText;
    const err = new Error(`HTTP ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function listModels({ baseUrl, apiKey }) {
  const { models } = endpoints(baseUrl);
  const data = await call(models, apiKey);
  const rows = data?.data || data?.models || [];
  return rows.map((m) => (typeof m === 'string' ? m : m.id || m.name || '')).filter(Boolean);
}

// 模型 id 不写死：优先用户填的那个，其次带 flash 的，再次带 deepseek 的。
function rankModels(ids, preferred) {
  if (preferred && ids.includes(preferred)) return [preferred, ...ids.filter((i) => i !== preferred)];
  const score = (id) => {
    if (preferred && id.toLowerCase().includes(preferred.toLowerCase())) return 0;
    if (/flash/i.test(id)) return 1;
    if (/deepseek/i.test(id)) return 2;
    return 3;
  };
  return [...ids].sort((a, b) => score(a) - score(b) || b.localeCompare(a, 'en', { numeric: true }));
}

async function resolveModel(cfg) {
  if (cfg.model) return cfg.model;
  const ranked = rankModels(await listModels(cfg), '');
  if (!ranked.length) throw new Error('这个端点的 /models 返回了空列表，请手动填模型 id');
  return ranked[0];
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p.text || '')).join('');
  return '';
}

async function understandScreenshot({ baseUrl, apiKey, model, images }) {
  const { chat } = endpoints(baseUrl);
  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          ...images.map(({ mimeType, base64 }) => ({
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${base64}` },
          })),
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 800,
  };
  const data = await call(chat, apiKey, { method: 'POST', body: JSON.stringify(body) });
  const raw = contentToText(data?.choices?.[0]?.message?.content);
  if (!raw) throw new Error(`返回内容为空（finish_reason：${data?.choices?.[0]?.finish_reason || '未知'}）`);
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

module.exports = { endpoints, baseUrlOrigin, listModels, rankModels, resolveModel, understandScreenshot };
