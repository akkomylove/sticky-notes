'use strict';

const api = window.sticky;
const $ = (role) => document.querySelector(`[data-role=${role}]`);
const els = {
  title: $('p-title'),
  count: $('p-count'),
  body: $('p-body'),
  img: $('p-img'),
  prev: document.querySelector('[data-act=prev]'),
  next: document.querySelector('[data-act=next]'),
};
let cur = null;

api.onPreview((p) => {
  cur = p;
  els.img.src = p.dataUrl;
  els.title.textContent = p.title || '截图预览';
  els.count.textContent = `${p.index + 1} / ${p.count}`;
  els.prev.disabled = p.count < 2;
  els.next.disabled = p.count < 2;
});

function step(delta) {
  if (!cur || cur.count < 2) return;
  api.previewImage(cur.id, (cur.index + delta + cur.count) % cur.count);
}

document.querySelector('.pbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.act === 'prev') step(-1);
  else if (btn.dataset.act === 'next') step(1);
  else window.close();
});

els.body.addEventListener('click', (e) => {
  if (e.target === els.body) window.close();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close();
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
});