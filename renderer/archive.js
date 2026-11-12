'use strict';

const api = window.sticky;
const $ = (role) => document.querySelector(`[data-role=${role}]`);
const els = {
  doneRows: $('done-rows'),
  doneEmpty: $('done-empty'),
  doneCount: $('done-count'),
  trashRows: $('trash-rows'),
  trashEmpty: $('trash-empty'),
  trashCount: $('trash-count'),
  keepDays: $('keep-days'),
};

function relative(ts) {
  if (!ts) return '';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  if (mins < 480) return `${Math.round(mins / 60)} 小时前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

function row(n, kind) {
  const ts = kind === 'done' ? n.doneAt : n.deletedAt;
  const el = document.createElement('div');
  el.className = 'row';
  el.dataset.id = n.id;

  const dot = Object.assign(document.createElement('span'), { className: 'dot' });
  dot.style.background = n.color;

  const name = Object.assign(document.createElement('span'), {
    className: kind === 'done' ? 'name struck' : 'name',
    textContent: n.title || (n.hasImage ? '（只有截图）' : '（无标题）'),
  });

  const when = Object.assign(document.createElement('span'), { className: 'when', textContent: relative(ts) });
  when.title = ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '';

  const btn = (act, icon, label, danger = false) => {
    const b = document.createElement('button');
    b.dataset.act = act;
    b.className = `row-btn${danger ? ' danger' : ''}`;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.innerHTML = `<svg class="ic" aria-hidden="true"><use href="#${icon}"/></svg>`;
    return b;
  };

  el.append(dot, name, when, ...(kind === 'done' ? [btn('uncomplete', 'i-undo', '放回未完成'), btn('trash', 'i-trash', '删除', true)] : [btn('restore', 'i-undo', '恢复'), btn('purge', 'i-trash', '彻底删除', true)]));
  return el;
}

function fill(host, emptyEl, countEl, list, kind) {
  host.replaceChildren(...list.map((n) => row(n, kind)));
  countEl.textContent = String(list.length);
  emptyEl.hidden = list.length > 0;
}

async function refresh() {
  const data = await api.archiveList();
  els.keepDays.textContent = String(data.trashKeepDays || 30);
  fill(els.doneRows, els.doneEmpty, els.doneCount, data.done, 'done');
  fill(els.trashRows, els.trashEmpty, els.trashCount, data.trash, 'trash');
}

async function act(actName, id) {
  const calls = {
    uncomplete: api.uncomplete,
    trash: api.moveToTrash,
    restore: api.restore,
    purge: api.purge,
  };
  if (actName === 'empty-trash') {
    if (!confirm('清空回收站？这些便签和它们独占的截图文件会一起删掉，无法恢复。')) return;
    await api.emptyTrash();
  } else if (calls[actName]) {
    if (actName === 'purge' && !confirm('彻底删除这条便签？它独占的截图文件会一起删掉，无法恢复。')) return;
    await calls[actName](id);
  }
  refresh();
}

document.querySelector('.wrap').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const rowEl = btn.closest('.row');
  act(btn.dataset.act, rowEl ? rowEl.dataset.id : null);
});

api.onArchiveRefresh(refresh);
window.addEventListener('focus', refresh);
refresh();
