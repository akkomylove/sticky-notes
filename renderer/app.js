'use strict';

const id = new URLSearchParams(location.search).get('id');
const api = window.sticky;
const $ = (role) => document.querySelector(`[data-role=${role}]`);
const els = {
  title: $('title'),
  body: $('body'),
  status: $('status'),
  shots: $('shots'),
  draft: $('draft'),
  draftName: $('draft-name'),
  draftMeta: $('draft-meta'),
  draftSummary: $('draft-summary'),
  draftPoints: $('draft-points'),
  stripTitle: $('strip-title'),
  swatches: $('swatches'),
  drawer: $('drawer'),
  drawerCollapse: $('drawer-collapse'),
  backend: $('backend'),
  baseurlField: $('baseurl-field'),
  baseurl: $('baseurl'),
  keyLabel: $('key-label'),
  key: $('key'),
  keyState: $('key-state'),
  model: $('model'),
  modelHint: $('model-hint'),
  saved: $('saved'),
};

let note = null;
let saveTimer = null;
let statusTimer = null;
let aiBusy = false;

// 底色由便签自己决定，渐变终点压暗 8% 保留纸张质感；色板都是浅底，深色字始终够对比度。
function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.max(0, Math.round(v * (1 - amount)));
  const r = f((n >> 16) & 255);
  const g = f((n >> 8) & 255);
  const b = f(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function paintColor(color) {
  document.documentElement.style.setProperty('--paper', color);
  document.documentElement.style.setProperty('--paper-2', shade(color, 0.08));
  for (const b of els.swatches.children) b.classList.toggle('on', b.dataset.color === color);
}

async function buildSwatches() {
  const palette = await api.palette();
  els.swatches.replaceChildren(
    ...palette.map((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.dataset.color = c.bg;
      b.title = `换成${c.name}色`;
      b.style.background = c.bg;
      return b;
    }),
  );
}

els.swatches.addEventListener('click', async (e) => {
  const btn = e.target.closest('.swatch');
  if (!btn) return;
  const next = await api.patch(id, { color: btn.dataset.color });
  if (next) applyNote(next);
});

function setStatus(text, isError = false, ttl = 0) {
  clearTimeout(statusTimer);
  els.status.classList.remove('fading');
  els.status.textContent = text || '';
  els.status.classList.toggle('err', isError);
  // 成功反馈自熄：2.2s 后淡出复原，错误信息常驻直到下一次操作。
  if (ttl > 0) {
    statusTimer = setTimeout(() => {
      if (els.status.textContent !== text) return;
      els.status.classList.add('fading');
      setTimeout(() => {
        if (els.status.textContent === text) setStatus('');
      }, 220);
    }, ttl);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  els.saved.textContent = '输入中…';
  saveTimer = setTimeout(saveNow, 400);
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!note) return;
  const next = await api.patch(note.id, { title: els.title.value, body: els.body.value });
  if (next) applyNote(next);
}

function applyNote(next) {
  note = next;
  paintColor(next.color);
  if (document.activeElement !== els.title) els.title.value = next.title || '';
  if (document.activeElement !== els.body) els.body.value = next.body || '';
  document.body.classList.toggle('is-collapsed', Boolean(next.collapsed));
  document.body.classList.toggle('is-expanded', !next.collapsed);
  els.stripTitle.textContent = next.title || (next.images?.length ? '（只有截图）' : '空便签');
  renderShots(next);
  renderDraft(next.draft);
  const pinBtn = document.querySelector('[data-act=pin]');
  pinBtn.classList.toggle('on', Boolean(next.pinned));
  pinBtn.title = next.pinned ? '取消置顶' : '置顶';
  pinBtn.setAttribute('aria-label', pinBtn.title);
  pinBtn.setAttribute('aria-pressed', String(Boolean(next.pinned)));
  els.saved.textContent = new Date(next.updatedAt || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
}

// 缩略图每张固定 56px：竖长图也不再撑高便签；点击开独立预览窗放大。
function renderShots(n) {
  const urls = n.imageDataUrls || [];
  els.shots.hidden = urls.length === 0;
  els.shots.replaceChildren(
    ...urls.map((url, i) => {
      const chip = document.createElement('div');
      chip.className = 'chip';
      const img = document.createElement('img');
      img.src = url;
      img.alt = `截图 ${i + 1}`;
      img.title = '点击放大';
      img.addEventListener('click', () => api.previewImage(id, i));
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'chip-x';
      x.title = '移除这张图';
      x.setAttribute('aria-label', `移除第 ${i + 1} 张图`);
      x.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-x"/></svg>';
      x.addEventListener('click', async () => {
        const res = await api.detachImage(id, n.images[i]);
        if (res.ok) applyNote(res.note);
        else setStatus(res.error, true);
      });
      chip.append(img, x);
      return chip;
    }),
  );
}

function renderDraft(draft) {
  els.draft.hidden = !draft;
  if (!draft) return;
  els.draftName.textContent = draft.task_name || '（没给出任务名）';
  els.draftSummary.textContent = draft.summary || '';
  els.draftMeta.textContent = [draft.due ? `截止 ${draft.due}` : '', draft.from ? `来自 ${draft.from}` : '', draft.model].filter(Boolean).join(' · ');
  els.draftPoints.replaceChildren(...(draft.points || []).map((p) => Object.assign(document.createElement('li'), { textContent: p })));
}

async function setCollapsed(collapsed) {
  await saveNow();
  const next = await api.collapse(id, collapsed);
  if (next) applyNote(next);
  else document.body.classList.toggle('is-collapsed', collapsed);
}

async function runAI() {
  if (aiBusy) return;
  if (!note?.images?.length) {
    setStatus('这张便签还没有截图，先 Ctrl+V 丢一张进来', true);
    return;
  }
  aiBusy = true;
  const btn = document.querySelector('[data-act=understand]');
  btn.disabled = true;
  setStatus('识别中…');
  try {
    const res = await api.understand(id);
    if (!res.ok) {
      setStatus(res.error, true);
      return;
    }
    const draft = res.note.draft;
    let patch = {};
    if (!els.title.value.trim() || els.title.value === '正在识别截图…') patch.title = draft.task_name;
    if (patch.title) await api.patch(id, patch);
    const fresh = await api.load(id);
    if (fresh) applyNote(fresh);
    const unread = draft.task_name === '无法识别的截图';
    setStatus(unread ? '没读出任务，看看原图或换一张' : '读好了，挑一个用', unread, unread ? 0 : 2200);
  } catch (err) {
    setStatus(err.message || '识别失败', true);
  } finally {
    aiBusy = false;
    btn.disabled = false;
  }
}

async function attachMany(buffers, { autoAi = false } = {}) {
  setStatus('存图中…');
  let last = null;
  let added = 0;
  for (const bytes of buffers) {
    let res;
    try {
      res = await api.attachFromBytes(id, bytes);
    } catch (err) {
      setStatus(err.message || '存图失败', true);
      return { added };
    }
    if (!res.ok) {
      setStatus(res.error, true);
      return { added };
    }
    last = res.note;
    if (res.added) added += 1;
  }
  if (last) applyNote(last);
  if (!added) {
    setStatus('这些图已经在便签里了，没重复加', false, 2200);
    return { added };
  }
  if (autoAi) await runAI();
  else setStatus(`已加入 ${added} 张，点「识别」读任务`, false, 2600);
  return { added };
}

async function attachFromClipboard() {
  setStatus('读剪贴板…');
  let res;
  try {
    res = await api.attachFromClipboard(id);
  } catch (err) {
    setStatus(err.message || '读剪贴板失败', true);
    return;
  }
  if (!res.ok) {
    setStatus(res.error, true);
    return;
  }
  applyNote(res.note);
  if (res.added === false) {
    setStatus('这张图已经在便签里了，没重复加', false, 2200);
    return;
  }
  setStatus('已加入 1 张，点「识别」读任务', false, 2600);
}

async function fromFiles(files) {
  const imgs = [...(files || [])].filter((f) => f.type.startsWith('image/'));
  if (!imgs.length) {
    setStatus('拖进来的不是图片', true);
    return;
  }
  const room = 5 - (note?.images?.length || 0);
  if (room <= 0) {
    setStatus('一张便签最多 5 张图，先移除几张再粘', true);
    return;
  }
  const take = imgs.slice(0, room);
  const buffers = [];
  for (const f of take) buffers.push(new Uint8Array(await f.arrayBuffer()));
  const { added } = await attachMany(buffers);
  if (imgs.length > room && added) setStatus(`最多 5 张：加了 ${added} 张，其余没加；点「识别」`, true);
}

function draftToBody(draft) {
  const lines = [];
  if (draft.summary) lines.push(draft.summary);
  if (draft.points?.length) lines.push('', ...draft.points.map((p) => `- ${p}`));
  if (draft.due) lines.push('', `⏰ 截止：${draft.due}`);
  if (draft.from) lines.push(`📮 来源：${draft.from}`);
  return lines.join('\n');
}

// ---------- 事件 ----------

els.title.addEventListener('input', scheduleSave);
els.body.addEventListener('input', scheduleSave);
els.title.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    els.body.focus();
  }
});
window.addEventListener('beforeunload', () => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    api.patch(id, { title: els.title.value, body: els.body.value });
  }
});

document.addEventListener('paste', (e) => {
  const ae = document.activeElement;
  if (ae === els.key || ae === els.model || ae === els.baseurl || ae === els.backend) return;
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) {
    e.preventDefault();
    fromFiles(files);
    return;
  }
  if (e.clipboardData?.getData('text/plain') && (ae === els.body || ae === els.title)) return;
  e.preventDefault();
  attachFromClipboard();
});

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('drag-over');
});
window.addEventListener('dragleave', () => document.body.classList.remove('drag-over'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('drag-over');
  if (note?.collapsed) setCollapsed(false);
  fromFiles(e.dataTransfer?.files);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !note?.collapsed) setCollapsed(true);
});

els.backend.addEventListener('change', syncBackendUI);

document.querySelector('.pane-strip').addEventListener('click', (e) => {
  if (e.target.closest('.strip-grip')) return;
  setCollapsed(false);
});

document.querySelector('.actions').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn) handleAction(btn.dataset.act);
});
document.querySelector('.ai').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn) handleAction(btn.dataset.act);
});
document.querySelector('.drawer').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn) handleAction(btn.dataset.act);
});
document.querySelector('.foot').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn) handleAction(btn.dataset.act);
});

function syncBackendUI() {
  const isGemini = els.backend.value === 'gemini';
  els.baseurlField.hidden = isGemini;
  els.keyLabel.textContent = isGemini ? 'Gemini API key' : 'API key';
  els.model.placeholder = '留空自动选择';
}

async function fillDrawer() {
  const cfg = await api.settings();
  els.backend.value = cfg.backend || 'openai';
  els.baseurl.value = cfg.baseUrl || '';
  els.model.value = cfg.model || '';
  els.keyState.textContent = cfg.hasKey ? '当前后端已配置 key' : '这个后端还没配 key，识别功能用不了';
  els.modelHint.textContent = `配置文件：${cfg.configPath}`;
  syncBackendUI();
}

async function handleAction(act) {
  switch (act) {
    case 'fold':
      setCollapsed(true);
      break;
    case 'settings': {
      const open = !els.drawerCollapse.classList.contains('open');
      els.drawerCollapse.classList.toggle('open', open);
      // 折叠动画 260ms 结束后再滚，量到的才是最终高度。
      if (open) fillDrawer().then(() => setTimeout(() => els.drawer.scrollIntoView({ block: 'nearest' }), 280));
      break;
    }
    case 'save-settings': {
      const res = await api.saveSettings({
        backend: els.backend.value,
        baseUrl: els.baseurl.value,
        apiKey: els.key.value,
        model: els.model.value,
      });
      if (!res.ok) {
        els.modelHint.textContent = res.error;
        return;
      }
      els.key.value = '';
      await fillDrawer();
      els.modelHint.textContent = `已保存：后端 ${res.backend} · 模型 ${res.model || '自动'} · ${res.hasKey ? 'key 已配置' : 'key 未配置'}`;
      setStatus('');
      break;
    }
    case 'list-models': {
      els.modelHint.textContent = '读取模型列表…';
      const res = await api.listModels();
      els.modelHint.textContent = res.ok
        ? `可选（共 ${res.total} 个）：${res.flash.join(' / ')}`
        : res.error;
      break;
    }
    case 'pin': {
      if (!note) return;
      const next = await api.patch(id, { pinned: !note.pinned });
      applyNote(next);
      break;
    }
    case 'delete': {
      if (!confirm('删除？便签会进回收站，30 天内可在托盘的「已完成 / 回收站」里恢复。')) return;
      await api.remove(id);
      break;
    }
    case 'complete': {
      await saveNow();
      const res = await api.complete(id);
      if (res && res.ok === false) setStatus(res.error || '标记失败', true);
      break;
    }
    case 'understand':
      runAI();
      break;
    case 'paste':
      attachFromClipboard();
      break;
    case 'adopt': {
      if (!note?.draft) return;
      els.title.value = note.draft.task_name;
      await saveNow();
      setStatus('任务名已采用', false, 2200);
      break;
    }
    case 'adopt-all': {
      if (!note?.draft) return;
      els.title.value = note.draft.task_name;
      els.body.value = draftToBody(note.draft);
      await saveNow();
      setStatus('已填入标题和正文', false, 2200);
      break;
    }
    case 'drop-draft': {
      const next = await api.patch(id, { draft: null });
      applyNote(next);
      setStatus('');
      break;
    }
    case 'new-note':
      api.newNote();
      break;
    case 'fold-all':
      api.foldAll(true);
      break;
    default:
      break;
  }
}

api.onUpdated((next) => {
  if (next && next.id === id) applyNote(next);
});

window.__smoke = {
  fold: (collapsed) => setCollapsed(collapsed),
  state: () => note,
  attachImage: (bytes) => attachMany([Uint8Array.from(bytes)]),
};

(async function init() {
  await buildSwatches();
  const loaded = await api.load(id);
  if (!loaded) {
    els.stripTitle.textContent = '便签已不存在';
    return;
  }
  applyNote(loaded);
  if (loaded.notice) setStatus(loaded.notice, true);
  if (loaded.autoRunAi && loaded.images?.length) runAI();
  els.title.focus({ preventScroll: true });
})();
