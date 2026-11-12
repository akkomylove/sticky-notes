'use strict';

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { pathToFileURL } = require('node:url');

const SMOKE = process.argv.includes('--smoke');

const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, nativeImage, globalShortcut, screen, shell } = require('electron');

// 打包后代码躺在只读的 app.asar 里，便签、截图、key 和缓存必须落在 exe 同目录。
// 便携版 NSIS 会把程序解压到 %TEMP% 再跑，此时 process.execPath 指向临时副本，
// 只有 launcher 传进来的 PORTABLE_EXECUTABLE_DIR 才是用户双击的那个 exe 所在目录。
if (app.isPackaged) {
  process.env.STICKY_NOTES_HOME = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
}
const store = require('./lib/store');
const ai = require('./lib/ai');
const { endpoints, baseUrlOrigin } = require('./lib/openai');

const { PALETTE } = require('./lib/palette');
const PALETTE_COLORS = PALETTE.map((c) => c.bg);

const SIZE = { expanded: { w: 344, h: 420 }, collapsed: { w: 236, h: 44 } };
const TRASH_KEEP_DAYS = 30;

const WELCOME = [
  '· 按住顶部小点区域拖动位置，位置会记住',
  '· 点右上折叠图标或按 Esc 折成窄条，点窄条任意处展开',
  '· 左边五个圆点换颜色',
  '· 微信 Alt+A 截完图 Ctrl+V 丢进来，可连粘多张（最多 5 张）；粘完不会自动识别，点「识别」才读任务，点缩略图看大图',
  '· 赶时间就按 Ctrl+Alt+V（任意软件里）= 新建便签 + 粘图 + 直接识别，一步到位',
  '· 对勾完成 → 收进托盘的「已完成 / 回收站」；叉删除 → 进回收站，30 天可恢复',
  '· 首次使用点右上 ⚙ 填自己的 API key，识别功能才可用',
  '· 关掉所有窗口不会退出，右下角托盘里有菜单；便签存在 exe 旁边的 data 文件夹',
].join('\n');
const OUTPUT_DIR = path.join(store.HOME, 'test-output');

const windows = new Map();
const rendererTargets = new WeakMap();
const webPreferences = {
  preload: path.join(store.ROOT, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false,
};
const pendingAi = new Set();
const pendingNotice = new Map();
const aiInFlight = new Set();
let tray = null;
let archiveWin = null;
let previewWin = null;
let previewNoteId = null;
let quitting = false;

// Electron 默认把 userData 写到 C 盘，这里挪到可写目录（开发=项目内，打包=exe 旁边），缓存不落 C 盘。
// 自检连缓存也隔离：正式实例可能正在运行，共用 .appdata 会抢缓存报「Unable to move the cache」。
app.setPath('userData', SMOKE ? path.join(store.HOME, 'test-output', '.appdata') : path.join(store.HOME, '.appdata'));

const gotLock = SMOKE || app.requestSingleInstanceLock();

function workArea() {
  return screen.getPrimaryDisplay().workArea;
}

function cascadeOrigin(index) {
  const area = workArea();
  const i = index % 6;
  return {
    x: area.x + area.width - SIZE.expanded.w - 28 - i * 26,
    y: area.y + 28 + i * 34,
  };
}

function allNotes() {
  return store.loadNotes();
}

function findNote(id) {
  return allNotes().find((n) => n.id === id) || null;
}

function persist(note) {
  const all = allNotes();
  const idx = all.findIndex((n) => n.id === note.id);
  if (idx === -1) all.unshift(note);
  else all[idx] = note;
  store.saveNotes(all);
  return note;
}

function patchNote(id, patch) {
  const existing = findNote(id);
  if (!existing) return null;
  const next = store.normalizeNote({ ...existing, ...patch, id, updatedAt: Date.now() });
  persist(next);
  return next;
}

function closeNoteWindow(id) {
  const win = windows.get(id);
  if (win && !win.isDestroyed()) win.close();
}

// 截图按哈希去重共用：只有没有任何便签再引用时才删文件。
function unlinkOrphans(images, remaining) {
  const stillRef = new Set(remaining.flatMap((n) => n.images));
  for (const rel of images) {
    if (stillRef.has(rel)) continue;
    const abs = store.resolveImage(rel);
    if (!abs) continue;
    try {
      fs.unlinkSync(abs);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[main] 删除截图失败', err.message);
    }
  }
}

// 彻底删除：只有没有任何便签再引用这张图时才删文件（截图按哈希去重）。
function hardDelete(id) {
  const all = allNotes();
  const victim = all.find((n) => n.id === id);
  if (!victim) return { ok: false, error: '便签不存在' };
  const remaining = all.filter((n) => n.id !== id);
  closeNoteWindow(id);
  unlinkOrphans(victim.images, remaining);
  store.saveNotes(remaining);
  notifyArchive();
  return { ok: true };
}

function withImages(note) {
  return note ? { ...note, imageDataUrls: note.images.map((rel) => store.readImageAsDataUrl(rel)) } : note;
}

// 只改尺寸，位置交给用户拖拽（moved 事件里落盘），折叠时保留左上角。
function applyWindowSize(win, note) {
  if (!win || win.isDestroyed()) return;
  const size = note.collapsed ? SIZE.collapsed : SIZE.expanded;
  const bounds = win.getContentBounds();
  if (bounds.width !== size.w || bounds.height !== size.h) win.setContentSize(size.w, size.h, true);
  win.setBackgroundColor(note.color);
  win.setAlwaysOnTop(Boolean(note.pinned), 'floating');
  win.setSkipTaskbar(Boolean(note.pinned));
}

const rendererErrors = [];
function attachDiagnostics(win) {
  win.webContents.on('console-message', (event) => {
    const { level, message, sourceId, lineNumber } = event || {};
    const name = typeof level === 'number' ? ['verbose', 'info', 'warn', 'error'][level] || level : level;
    if (name === 'error') rendererErrors.push(`${message} (${path.basename(String(sourceId || ''))}:${lineNumber})`);
    console.log(`[renderer ${name}] ${message} (${path.basename(String(sourceId || ''))}:${lineNumber})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.log(`[did-fail-load] ${code} ${desc} ${url}`));
  win.webContents.on('preload-error', (_e, file, error) => console.log(`[preload-error] ${file}: ${error.message}`));
  win.webContents.on('render-process-gone', (_e, details) => console.log(`[render-process-gone] ${JSON.stringify(details)}`));
}

function loadAppPage(win, page, noteId) {
  const url = pathToFileURL(path.join(store.ROOT, 'renderer', page));
  if (noteId !== undefined) url.searchParams.set('id', noteId);
  const contents = win.webContents;
  rendererTargets.set(contents, { page, url: url.href, noteId });
  contents.on('will-frame-navigate', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  attachDiagnostics(win);
  win.loadURL(url.href);
}

function openNoteWindow(note) {
  const existing = windows.get(note.id);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    return existing;
  }
  const size = note.collapsed ? SIZE.collapsed : SIZE.expanded;
  const pos = note.x != null && note.y != null ? { x: note.x, y: note.y } : cascadeOrigin(windows.size);
  const win = new BrowserWindow({
    ...pos,
    width: size.w,
    height: size.h,
    useContentSize: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    backgroundColor: note.color,
    icon: path.join(store.ROOT, 'renderer', 'assets', 'icon-256.png'),
    hasShadow: true,
    show: false,
    skipTaskbar: Boolean(note.pinned),
    alwaysOnTop: Boolean(note.pinned),
    webPreferences,
  });

  windows.set(note.id, win);
  if (note.x == null || note.y == null) patchNote(note.id, { x: pos.x, y: pos.y });
  loadAppPage(win, 'index.html', note.id);

  let geometryTimer = null;
  win.on('moved', () => {
    clearTimeout(geometryTimer);
    geometryTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      patchNote(note.id, { x, y });
    }, 350);
  });
  win.on('closed', () => windows.delete(note.id));
  win.webContents.on('context-menu', (_e, params) => {
    // 现查最新状态：开窗时的快照会让折叠/置顶菜单的启用态和文案停在旧值。
    const cur = findNote(note.id) || note;
    Menu.buildFromTemplate([
      { label: '展开', enabled: cur.collapsed, click: () => fold(note.id, false) },
      { label: '折叠', enabled: !cur.collapsed, click: () => fold(note.id, true) },
      { label: cur.pinned ? '取消置顶' : '置顶显示', click: () => togglePin(note.id) },
      { type: 'separator' },
      { label: '标记完成（收进归档）', click: () => completeNote(note.id) },
      { label: '删除（进回收站）', click: () => trashNote(note.id) },
      { label: '打开数据目录', click: () => shell.openPath(store.DATA_DIR) },
      { role: 'reload' },
      { role: 'toggleDevTools' },
    ]).popup({ window: win, x: params.x, y: params.y });
  });
  win.once('ready-to-show', () => win.show());
  return win;
}

function broadcast(note) {
  const win = windows.get(note.id);
  if (win && !win.isDestroyed()) win.webContents.send('note:updated', withImages(note));
}

function notifyArchive() {
  if (!archiveWin || archiveWin.isDestroyed()) return;
  archiveWin.webContents.send('archive:refresh');
}

function createNote(patch = {}) {
  const cfgColor = String(store.loadConfig().noteColor || '').toLowerCase();
  const color = patch.color || (PALETTE_COLORS.includes(cfgColor) ? cfgColor : PALETTE[0].bg);
  const note = store.normalizeNote({ ...patch, id: store.newId(), color });
  persist(note);
  openNoteWindow(note);
  notifyArchive();
  return note;
}

// 删除 = 进回收站，还能拉回来；彻底删除走 hardDelete。
function trashNote(id) {
  const note = patchNote(id, { deleted: true, deletedAt: Date.now() });
  closeNoteWindow(id);
  notifyArchive();
  return note;
}

function completeNote(id) {
  const note = patchNote(id, { done: true, doneAt: Date.now(), collapsed: false });
  closeNoteWindow(id);
  notifyArchive();
  return note;
}

// 取消完成 / 从回收站拉回：都是让便签重新回到桌面并开窗。
function bringBack(id, patch) {
  const note = patchNote(id, patch);
  if (!note) return null;
  openNoteWindow(note);
  notifyArchive();
  return note;
}

function fold(id, collapsed) {
  const note = patchNote(id, { collapsed });
  if (!note) return null;
  applyWindowSize(windows.get(id), note);
  broadcast(note);
  return note;
}

function togglePin(id) {
  const note = findNote(id);
  if (!note) return null;
  return refreshNote(patchNote(id, { pinned: !note.pinned }));
}

function refreshNote(note) {
  if (!note) return null;
  applyWindowSize(windows.get(note.id), note);
  broadcast(note);
  return note;
}

function setAllCollapsed(collapsed) {
  for (const note of store.liveNotes(allNotes())) {
    if (note.collapsed !== collapsed) fold(note.id, collapsed);
  }
}

function showAllWindows() {
  for (const win of windows.values()) if (!win.isDestroyed()) win.show();
  if (archiveWin && !archiveWin.isDestroyed()) archiveWin.show();
}

// 归档窗口只有一个，重复点托盘就把它唤到前面。
function openArchiveWindow() {
  if (archiveWin && !archiveWin.isDestroyed()) {
    archiveWin.show();
    archiveWin.focus();
    return archiveWin;
  }
  archiveWin = new BrowserWindow({
    width: 480,
    height: 600,
    minWidth: 380,
    minHeight: 320,
    useContentSize: true,
    title: '已完成与回收站',
    icon: path.join(store.ROOT, 'renderer', 'assets', 'icon-256.png'),
    backgroundColor: '#fafafa',
    show: false,
    webPreferences,
  });
  loadAppPage(archiveWin, 'archive.html');
  archiveWin.once('ready-to-show', () => archiveWin.show());
  archiveWin.on('closed', () => {
    archiveWin = null;
  });
  return archiveWin;
}

// ---------- 图片进出 ----------

function imageFromBytes(bytes) {
  const img = nativeImage.createFromBuffer(Buffer.from(bytes));
  return img.isEmpty() ? null : img;
}

// Electron 45 删掉了 readImage/readBuffer：系统剪贴板只能走 read() + ClipboardItem.getType()。
async function imageFromClipboard() {
  for (const item of await clipboard.read()) {
    const type = (item.types || []).find((t) => t.startsWith('image/'));
    if (!type) continue;
    const blob = await item.getType(type);
    const img = imageFromBytes(new Uint8Array(await blob.arrayBuffer()));
    if (img) return img;
  }
  return null;
}

function saveImage(img) {
  return store.saveImage(img.toPNG());
}

async function attachImage(id, bytes) {
  const existing = findNote(id);
  if (!existing) return { ok: false, error: '便签不存在' };
  const img = bytes ? imageFromBytes(bytes) : await imageFromClipboard();
  if (!img) return { ok: false, error: '剪贴板或拖进来的文件里没有图片' };
  const saved = saveImage(img);
  if (existing.images.includes(saved.rel)) return { ok: true, added: false, note: withImages(existing) };
  if (existing.images.length >= store.MAX_IMAGES) {
    return { ok: false, error: `一张便签最多 ${store.MAX_IMAGES} 张图，先移除几张再粘` };
  }
  const note = patchNote(id, { images: [...existing.images, saved.rel], draft: null });
  broadcast(note);
  return { ok: true, added: true, note: withImages(note) };
}

function detachImage(id, rel) {
  const existing = findNote(id);
  if (!existing) return { ok: false, error: '便签不存在' };
  const note = patchNote(id, { images: existing.images.filter((r) => r !== rel), draft: null });
  if (!note) return { ok: false, error: '便签不存在' };
  unlinkOrphans([rel], allNotes());
  broadcast(note);
  return { ok: true, note: withImages(note) };
}
// 送进模型的图先降到最长边 1400px（滚动长截图宽度不大但可能极高），原图仍完整存在 data/images 里。
function shrinkForModel(img) {
  const { width, height } = img.getSize();
  if (Math.max(width, height) <= 1400) return img;
  return width >= height ? img.resize({ width: 1400 }) : img.resize({ height: 1400 });
}

async function runUnderstand(id, cfg = store.loadConfig()) {
  const note = findNote(id);
  if (!note?.images.length) return { ok: false, error: '先给这张便签粘一张截图' };
  if (!ai.keyOf(cfg)) return { ok: false, error: '还没配 API key，点便签右上的齿轮填' };
  if (cfg.backend === 'openai' && !String(cfg.baseUrl).trim()) {
    return { ok: false, error: 'OpenAI 兼容后端还缺 Base URL，点齿轮在设置里填 https://…/v1' };
  }
  // 识别要花真金白银的 API 调用：连点/粘图重入只放一个请求出去。
  if (aiInFlight.has(id)) return { ok: false, error: '这张便签正在识别中，等它读完' };
  aiInFlight.add(id);
  try {
    const images = [];
    for (const rel of note.images) {
      const abs = store.resolveImage(rel);
      if (!abs) return { ok: false, error: '截图路径不合法' };
      const img = imageFromBytes(fs.readFileSync(abs));
      if (!img) return { ok: false, error: '截图文件读不出来' };
      images.push({ mimeType: 'image/png', base64: shrinkForModel(img).toPNG().toString('base64') });
    }
    const draft = await ai.describe(cfg, images);
    const patched = patchNote(id, { draft: { ...draft, at: Date.now() } });
    // 识别的几秒里便签可能被完成/删除：结果丢弃，别拿 null 去广播。
    if (!patched) return { ok: false, error: '便签已不存在，识别结果丢弃' };
    broadcast(patched);
    return { ok: true, note: patched };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    aiInFlight.delete(id);
  }
}

async function newNoteFromClipboard() {
  const img = await imageFromClipboard();
  if (!img) {
    const note = createNote({});
    pendingNotice.set(note.id, '剪贴板里没有图片：先截图或复制图，再按 Ctrl+Alt+V');
    return note;
  }
  const saved = saveImage(img);
  const note = createNote({ images: [saved.rel], title: '正在识别截图…' });
  pendingAi.add(note.id);
  return note;
}

// 点击缩略图的放大预览：独立小窗，竖长图按工作区高度适配，不再挤占便签本体。
function openPreview(id, index) {
  const note = findNote(id);
  if (!note?.images.length) return { ok: false, error: '这张便签没有截图' };
  const i = Math.min(Math.max(0, Math.floor(index)), note.images.length - 1);
  const abs = store.resolveImage(note.images[i]);
  if (!abs) return { ok: false, error: '截图路径不合法' };
  let src = { width: 480, height: 360 };
  const img = nativeImage.createFromPath(abs);
  if (!img.isEmpty()) src = img.getSize();
  const area = workArea();
  const scale = Math.min(1, (area.width * 0.86) / src.width, (area.height * 0.86 - 30) / src.height);
  const w = Math.max(260, Math.round(src.width * scale));
  const h = Math.max(200, Math.round(src.height * scale)) + 30;
  const payload = {
    id,
    index: i,
    count: note.images.length,
    title: note.title,
    dataUrl: store.readImageAsDataUrl(note.images[i]),
  };
  previewNoteId = id;
  if (previewWin && !previewWin.isDestroyed()) {
    previewWin.setContentSize(w, h);
    previewWin.center();
    previewWin.webContents.send('preview:show', payload);
    previewWin.show();
    previewWin.focus();
    return { ok: true };
  }
  previewWin = new BrowserWindow({
    width: w,
    height: h,
    useContentSize: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    backgroundColor: '#221e18',
    icon: path.join(store.ROOT, 'renderer', 'assets', 'icon-256.png'),
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences,
  });
  loadAppPage(previewWin, 'preview.html');
  previewWin.webContents.once('did-finish-load', () => {
    if (previewWin && !previewWin.isDestroyed()) {
      previewWin.webContents.send('preview:show', payload);
      previewWin.show();
    }
  });
  previewWin.on('closed', () => {
    previewWin = null;
    previewNoteId = null;
  });
  return { ok: true };
}

// ---------- IPC ----------

function normalizePatch(patch) {
  const out = {};
  if (typeof patch.title === 'string') out.title = patch.title.slice(0, 120);
  if (typeof patch.body === 'string') out.body = patch.body.slice(0, 20000);
  // 颜色只收预设色板里的值，避免任意字符串进 setBackgroundColor。
  if (PALETTE_COLORS.includes(String(patch.color).toLowerCase())) out.color = String(patch.color).toLowerCase();
  if (typeof patch.collapsed === 'boolean') out.collapsed = patch.collapsed;
  if (typeof patch.pinned === 'boolean') out.pinned = patch.pinned;
  if (Array.isArray(patch.images)) {
    out.images = patch.images.filter((r) => typeof r === 'string' && store.resolveImage(r)).slice(0, store.MAX_IMAGES);
  }
  if (patch.draft === null || typeof patch.draft === 'object') out.draft = patch.draft;
  return out;
}

function registerIpc() {
  const notePage = 'index.html';
  const archivePage = 'archive.html';
  const previewPage = 'preview.html';
  const handle = (channel, pages, callback) => {
    ipcMain.handle(channel, (event, payload) => {
      const frame = event.senderFrame;
      const target = rendererTargets.get(event.sender);
      if (!frame || frame.parent || !target || target.url !== frame.url || !pages.includes(target.page)) {
        throw new Error('拒绝来自非授权页面的操作');
      }
      return callback(payload, target);
    });
  };
  const handleNote = (channel, callback) => handle(channel, [notePage], (payload, target) => {
    const id = String(payload?.id ?? payload ?? '');
    if (id !== target.noteId) throw new Error('该窗口只能操作自己的便签');
    return callback(id, payload);
  });

  handleNote('note:load', (id) => {
    const note = findNote(String(id));
    if (!note) return null;
    const notice = pendingNotice.get(note.id) || null;
    pendingNotice.delete(note.id);
    return { ...withImages(note), autoRunAi: pendingAi.delete(note.id), notice };
  });
  handle('palette:list', [notePage], () => PALETTE);
  handle('note:create', [notePage], (patch) => withImages(createNote(normalizePatch(patch || {}))));
  handleNote('note:delete', (id) => Boolean(trashNote(id)));
  handleNote('note:complete', (id) => {
    const note = completeNote(id);
    return note ? { ok: true } : { ok: false, error: '便签不存在' };
  });
  handle('archive:list', [archivePage], () => {
    const all = allNotes();
    const shape = (n) => ({
      id: n.id,
      title: n.title,
      color: n.color,
      hasImage: n.images.length > 0,
      doneAt: n.doneAt,
      deletedAt: n.deletedAt,
      fromTrash: n.deleted,
    });
    return {
      done: store.doneNotes(all).map(shape),
      trash: store.trashedNotes(all).map(shape),
      trashKeepDays: TRASH_KEEP_DAYS,
    };
  });
  handle('archive:uncomplete', [archivePage], (id) => {
    const note = bringBack(String(id), { done: false, doneAt: null });
    return note ? { ok: true } : { ok: false, error: '便签不存在' };
  });
  handle('archive:restore', [archivePage], (id) => {
    const note = bringBack(String(id), { deleted: false, deletedAt: null });
    return note ? { ok: true } : { ok: false, error: '便签不存在' };
  });
  handle('archive:trash', [archivePage], (id) => Boolean(trashNote(String(id))));
  handle('archive:purge', [archivePage], (id) => {
    const note = findNote(String(id));
    return note?.deleted ? hardDelete(note.id) : { ok: false, error: '只能彻底删除回收站中的便签' };
  });
  handle('archive:emptyTrash', [archivePage], () => {
    const ids = store.trashedNotes(allNotes()).map((n) => n.id);
    for (const id of ids) hardDelete(id);
    return { ok: true, purged: ids.length };
  });
  handleNote('note:patch', (id, payload) => {
    const note = patchNote(id, normalizePatch(payload?.patch || {}));
    if (!note) return null;
    applyWindowSize(windows.get(id), note);
    broadcast(note);
    return withImages(note);
  });
  handleNote('window:collapse-self', (id, payload) => {
    const next = fold(id, Boolean(payload?.collapsed));
    return next ? withImages(next) : null;
  });
  handleNote('image:attach', (id, payload) => attachImage(id, payload?.bytes));
  handleNote('image:detach', (id, payload) => detachImage(id, String(payload?.rel || '')));
  handle('image:preview', [notePage, previewPage], (payload, target) => {
    const id = String(payload?.id || '');
    const allowedId = target.page === previewPage ? previewNoteId : target.noteId;
    if (id !== allowedId) throw new Error('该窗口只能预览当前便签的截图');
    return openPreview(id, Number(payload?.index) || 0);
  });
  handleNote('ai:understand', (id) => runUnderstand(id));
  handle('cfg:get', [notePage], () => {
    const cfg = store.loadConfig();
    const key = ai.keyOf(cfg);
    return {
      backend: cfg.backend,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      hasKey: Boolean(key),
      noteColor: cfg.noteColor,
      configPath: store.CONFIG_FILE,
    };
  });
  handle('cfg:set', [notePage], (payload) => {
    const cfg = store.loadConfig();
    const backend = payload?.backend === 'gemini' || payload?.backend === 'openai' ? payload.backend : cfg.backend;
    const patch = { backend };
    const key = typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : '';
    if (backend === 'openai' && typeof payload?.baseUrl === 'string') {
      const baseUrl = payload.baseUrl.trim();
      try {
        patch.baseUrl = baseUrl ? endpoints(baseUrl).root : '';
        if (!SMOKE && process.env.OPENAI_BASE_URL) {
          if (patch.baseUrl !== endpoints(cfg.baseUrl).root) {
            return { ok: false, error: '请修改环境变量 OPENAI_BASE_URL 来更换地址' };
          }
          if (!key) delete patch.baseUrl;
        } else if (!SMOKE && process.env.OPENAI_API_KEY && baseUrlOrigin(patch.baseUrl) !== baseUrlOrigin(cfg.baseUrl)) {
          return { ok: false, error: '请同时设置 OPENAI_BASE_URL 和 OPENAI_API_KEY 来更换地址' };
        }
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    if (typeof payload?.model === 'string') patch.model = payload.model.trim();
    if (key) patch[backend === 'gemini' ? 'geminiApiKey' : 'apiKey'] = key;
    if (typeof payload?.noteColor === 'string' && /^#[0-9a-f]{6}$/i.test(payload.noteColor)) patch.noteColor = payload.noteColor;
    store.saveConfig(patch);
    const saved = store.loadConfig();
    return {
      ok: true,
      backend: saved.backend,
      model: saved.model,
      hasKey: Boolean(ai.keyOf(saved)),
      configPath: store.CONFIG_FILE,
    };
  });
  handle('models:list', [notePage], async () => {
    const cfg = store.loadConfig();
    if (!ai.keyOf(cfg)) return { ok: false, error: '还没配 API key' };
    try {
      const { candidates, total } = await ai.listModels(cfg);
      return { ok: true, flash: candidates, total, backend: cfg.backend };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  handle('app:newNote', [notePage], () => withImages(createNote({})));
  handle('app:newNoteFromClipboard', [notePage], async () => withImages(await newNoteFromClipboard()));
  handle('app:foldAll', [notePage], (collapsed) => {
    setAllCollapsed(Boolean(collapsed));
    return true;
  });
  handle('app:openData', [notePage], () => shell.openPath(store.DATA_DIR));
  handle('app:quit', [notePage], () => {
    quitting = true;
    app.quit();
    return true;
  });
}

// ---------- 托盘 / 全局热键 ----------

function tinyPngIcon() {
  const crcTable = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const trailer = Buffer.alloc(4);
    trailer.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, trailer]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(16, 0);
  ihdr.writeUInt32BE(16, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(16 * 65);
  for (let y = 0; y < 16; y += 1) {
    raw[y * 65] = 0;
    for (let x = 0; x < 16; x += 1) {
      const o = y * 65 + 1 + x * 4;
      raw[o] = 0xfb;
      raw[o + 1] = 0xe9;
      raw[o + 2] = 0xa0;
      raw[o + 3] = y > 12 ? 120 : 255;
    }
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: '新建便签  Ctrl+Alt+N', click: () => createNote({}) },
    { label: '粘截图建任务  Ctrl+Alt+V', click: () => newNoteFromClipboard() },
    { type: 'separator' },
    { label: '全部展开', click: () => setAllCollapsed(false) },
    { label: '全部折叠', click: () => setAllCollapsed(true) },
    { label: '唤到前台', click: () => showAllWindows() },
    { type: 'separator' },
    { label: '已完成 / 回收站', click: () => openArchiveWindow() },
    { label: '打开便签数据目录', click: () => shell.openPath(store.DATA_DIR) },
    { label: '退出便签', click: () => { quitting = true; app.quit(); } },
  ]);
}

function buildTray() {
  // 托盘图标跟系统缩放走：100% 用 16，150% 用 24，避免 Windows 自己缩糊。
  const want = 16 * (screen.getPrimaryDisplay().scaleFactor || 1);
  const px = [16, 24, 32].reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
  const icon = nativeImage.createFromPath(path.join(store.ROOT, 'renderer', 'assets', `icon-${px}.png`));
  if (icon.isEmpty()) return;
  tray = new Tray(icon);
  tray.setToolTip('桌面便签');
  tray.setContextMenu(trayMenu());
  tray.on('double-click', () => newNoteFromClipboard());
}

function registerShortcuts() {
  for (const [accel, fn] of [
    ['CommandOrControl+Alt+N', () => createNote({})],
    ['CommandOrControl+Alt+V', () => newNoteFromClipboard()],
  ]) {
    if (!globalShortcut.register(accel, fn)) console.warn(`[main] 热键 ${accel} 注册失败（多半被别的软件占了）`);
  }
}

// ---------- 自检 ----------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
// Win11 给 frameless 窗口留了 1px 边框 + 阴影区，150% 缩放下实测比声明值多约 4 DIP，
// 所以尺寸断言按“足够接近 + 折叠态确实矮一大截”来判，不抠精确像素。
const DIP_TOL = 8;
const near = (a, b) => Math.abs(a - b) <= DIP_TOL;
const measured = {};
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function runSmoke() {
  try {
    await smokeSteps();
  } catch (err) {
    check('自检过程抛异常', false, (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err)));
  }
  const failures = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'smoke-report.json'), JSON.stringify({ results, size: SIZE, measured }, null, 2));
  console.log(`\nSMOKE ${failures.length ? 'FAILED' : 'OK'} — ${results.length - failures.length}/${results.length} passed`);
  quitting = true;
  app.exit(failures.length ? 1 : 0);
}

async function smokeSteps() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  store.saveNotes([]);
  check('托盘图标已加载', tray !== null && !tray.isDestroyed(), '');
  // 上一轮自检可能往隔离目录写过 config，先清掉，否则「未配 key」这条会被残留 key 骗过。
  fs.rmSync(store.CONFIG_FILE, { force: true });

  const a = createNote({ title: '准备活动物料', body: '海报、易拉宝、报名表。\n截止：周五' });
  await wait(1000);
  const winA = windows.get(a.id);
  check('新建便签开窗', winA && !winA.isDestroyed(), a.id);
  const probe = await winA.webContents.executeJavaScript(`({
    hasApi: typeof window.sticky,
    hasBridge: typeof window.sticky === 'object' && typeof window.sticky?.load === 'function',
    titleEl: Boolean(document.querySelector('[data-role=title]')),
    smoke: typeof window.__smoke,
    inner: [innerWidth, innerHeight],
    bodyClass: document.body.className,
    href: location.href.slice(-40),
  })`);
  const blockedIpc = await winA.webContents.executeJavaScript(`(async () => {
    const blocked = (operation) => operation.then(() => false, () => true);
    return {
      foreignNote: await blocked(window.sticky.load('different-note')),
      archive: await blocked(window.sticky.archiveList()),
    };
  })()`);
  check('便签窗口只能读取自己的便签和使用所属页面的接口', blockedIpc.foreignNote && blockedIpc.archive, JSON.stringify(blockedIpc));
  console.log('PROBE', JSON.stringify(probe));
  console.log('BOUNDS', JSON.stringify(winA.getBounds()), 'CONTENT', JSON.stringify(winA.getContentBounds()), 'SCALE', screen.getPrimaryDisplay().scaleFactor);
  const expBounds = winA.getContentBounds();
  measured.expanded = { w: expBounds.width, h: expBounds.height };
  check('展开态尺寸符合预期', near(expBounds.height, SIZE.expanded.h) && near(expBounds.width, SIZE.expanded.w), `${expBounds.width}x${expBounds.height}（声明 ${SIZE.expanded.w}x${SIZE.expanded.h}）`);

  const rendered = await winA.webContents.executeJavaScript('document.querySelector("[data-role=title]").value');
  check('标题渲染进 DOM', rendered === a.title, JSON.stringify(rendered));
  const iconAudit = await winA.webContents.executeJavaScript(`(() => {
    const btns = [...document.querySelectorAll('.actions button, .foot button, .drawer-tools button, .ai-row button, .draft-tools button')];
    return {
      total: btns.length,
      labeled: btns.filter((b) => b.getAttribute('aria-label') || b.title || b.textContent.trim()).length,
      barText: [...document.querySelectorAll('.actions button')].map((b) => b.textContent.trim()).join(''),
      withSvg: btns.filter((b) => b.querySelector('svg.ic')).length,
    };
  })()`);
  check('工具按钮图标化且都有可读标签', iconAudit.barText === '' && iconAudit.labeled === iconAudit.total && iconAudit.withSvg === iconAudit.total - 1, JSON.stringify(iconAudit));

  const before = winA.getPosition();
  await winA.webContents.executeJavaScript('window.__smoke.fold(true)');
  await wait(600);
  const boundsFolded = winA.getContentBounds();
  measured.collapsed = { w: boundsFolded.width, h: boundsFolded.height };
  const bodyClass = await winA.webContents.executeJavaScript('document.body.className');
  check('折叠成窄条', bodyClass.includes('is-collapsed') && near(boundsFolded.height, SIZE.collapsed.h) && near(boundsFolded.width, SIZE.collapsed.w), `class="${bodyClass}" ${boundsFolded.width}x${boundsFolded.height}`);
  // 比较必须同坐标系：getContentBounds 的 x 比 getPosition 多 1px 阴影内缩。
  const after = winA.getPosition();
  check('折叠不跳位', after[0] === before[0] && after[1] === before[1], JSON.stringify({ before, after }));
  check('窄条比展开态矮一大截', measured.expanded.h - boundsFolded.height > 200, `Δh=${measured.expanded.h - boundsFolded.height}`);
  const stripText = await winA.webContents.executeJavaScript('document.querySelector("[data-role=strip-title]").textContent');
  check('窄条显示任务名', stripText === a.title, JSON.stringify(stripText));

  await winA.webContents.executeJavaScript('window.__smoke.fold(false)');
  await wait(600);
  check('再次展开回到原尺寸', near(winA.getContentBounds().height, SIZE.expanded.h), `h=${winA.getContentBounds().height}`);

  const b = createNote({ title: '第二条便签', collapsed: true });
  await wait(900);
  check('折叠态新建也正常', near(windows.get(b.id)?.getContentBounds().height, SIZE.collapsed.h), `h=${windows.get(b.id)?.getContentBounds().height}`);

  const onDisk = store.loadNotes();
  check('落盘条数', onDisk.length === 2, `notes.json=${onDisk.length}`);
  check('折叠状态持久化', onDisk.find((n) => n.id === a.id)?.collapsed === false, '');
  check('位置已持久化', Number.isInteger(onDisk.find((n) => n.id === a.id)?.x), String(onDisk.find((n) => n.id === a.id)?.x));

  // 用程序生成的合法 16x16 PNG，避免手写 base64 截断成 0 字节假图。
  const sample = nativeImage.createFromBuffer(tinyPngIcon());
  check('自检样本图非空', !sample.isEmpty(), JSON.stringify(sample.getSize()));
  const saved = saveImage(sample);
  const withImg = patchNote(a.id, { images: [saved.rel] });
  // 必须广播到窗口：用户粘图后缩略图排会占高度，不渲染就量不到抽屉被顶出窗口的真实布局。
  broadcast(withImg);
  await wait(300);
  check('截图落盘', fs.existsSync(path.join(store.DATA_DIR, saved.rel)), saved.rel);
  check('dataURL 可回读', String(store.readImageAsDataUrl(withImg.images[0])).startsWith('data:image/png;base64,'), '');
  const badImagePatch = normalizePatch({ images: ['../config.json'] });
  check('越界的截图路径进不了便签', badImagePatch.images.length === 0 && store.resolveImage('../config.json') === null, JSON.stringify(badImagePatch));
  const tall = nativeImage.createFromBitmap(Buffer.alloc(100 * 3000 * 4), { width: 100, height: 3000 });
  const tallShrunk = shrinkForModel(tall).getSize();
  check('超长截图按最长边降尺寸', Math.max(tallShrunk.width, tallShrunk.height) <= 1400, JSON.stringify(tallShrunk));

  // ---------- 多图 / 剪贴板 / 缩略图 / 预览 ----------
  const legacy = store.normalizeNote({ id: 'legacy', image: saved.rel });
  check('旧单图数据迁进 images 数组', legacy.images.length === 1 && legacy.images[0] === saved.rel && !('image' in legacy), JSON.stringify(legacy.images));
  const dup = await attachImage(a.id, tinyPngIcon());
  check('重复粘同一张图不重复加', dup.ok === true && dup.added === false && dup.note.images.length === 1, JSON.stringify(dup.note?.images));
  const fillers = [
    nativeImage.createFromBitmap(Buffer.alloc(8 * 8 * 4, 0x40), { width: 8, height: 8 }).toPNG(),
    nativeImage.createFromBitmap(Buffer.alloc(8 * 8 * 4, 0x80), { width: 8, height: 8 }).toPNG(),
    nativeImage.createFromBitmap(Buffer.alloc(60 * 900 * 4, 0xc0), { width: 60, height: 900 }).toPNG(),
    nativeImage.createFromBitmap(Buffer.alloc(900 * 60 * 4, 0x60), { width: 900, height: 60 }).toPNG(),
  ];
  for (const buf of fillers) {
    const r = await attachImage(a.id, buf);
    if (!r.ok) check('多图逐张接入', false, r.error);
  }
  check('多图累加到 5 张', findNote(a.id).images.length === store.MAX_IMAGES, String(findNote(a.id).images.length));
  const sixth = await attachImage(a.id, nativeImage.createFromBitmap(Buffer.alloc(4 * 4 * 4, 0x11), { width: 4, height: 4 }).toPNG());
  check('第 6 张被上限拦下', sixth.ok === false && /最多 5 张/.test(sixth.error || ''), sixth.error);
  broadcast(findNote(a.id));
  await wait(400);
  const chipGeom = await winA.webContents.executeJavaScript(`(() => {
    const chips = [...document.querySelectorAll('.chip')];
    const sizes = chips.map((c) => { const r = c.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
    const bodyR = document.querySelector('[data-role=body]').getBoundingClientRect();
    const shotsR = document.querySelector('[data-role=shots]').getBoundingClientRect();
    return { count: chips.length, sizes, bodyH: Math.round(bodyR.height), shotsH: Math.round(shotsR.height) };
  })()`);
  check('缩略图每张固定 56px 且正文不被挤没', chipGeom.count === 5 && chipGeom.sizes.every(([w, h]) => w === 56 && h === 56) && chipGeom.shotsH <= 62 && chipGeom.bodyH >= 60, JSON.stringify(chipGeom));
  const rels = findNote(a.id).images;
  const det = detachImage(a.id, rels[1]);
  check('单张移除只掉一张', det.ok && det.note.images.length === 4 && !det.note.images.includes(rels[1]), JSON.stringify(det.note.images));
  check('移除的独占图文件清掉', !fs.existsSync(path.join(store.DATA_DIR, rels[1])), rels[1]);

  const pv = openPreview(a.id, 2);
  await wait(900);
  check('点缩略图开放大预览窗', pv.ok && previewWin && !previewWin.isDestroyed(), '');
  const pvBounds = previewWin.getContentBounds();
  check('竖长图预览窗窄而高', pvBounds.height > 400 && pvBounds.width < 300, JSON.stringify(pvBounds));
  const pvState = await previewWin.webContents.executeJavaScript(`({
    src: Boolean(document.querySelector('[data-role=p-img]').src),
    count: document.querySelector('[data-role=p-count]').textContent,
  })`);
  check('预览窗收到图与序号', pvState.src && pvState.count === '3 / 4', JSON.stringify(pvState));
  const shotPreview = await previewWin.webContents.capturePage();
  fs.writeFileSync(path.join(OUTPUT_DIR, '04-preview.png'), shotPreview.toPNG());
  previewWin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  previewWin.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await wait(500);
  check('Esc 关掉预览窗', previewWin === null, '');

  // 不碰系统剪贴板：替身 read() 验证新 API 读图与读不到时的反馈。
  const origRead = clipboard.read;
  clipboard.read = async () => [{ types: ['image/png'], getType: async () => new Blob([tinyPngIcon()]) }];
  const clipImg = await imageFromClipboard();
  check('新剪贴板 API 读到图', clipImg !== null && !clipImg.isEmpty(), JSON.stringify(clipImg?.getSize()));
  clipboard.read = async () => [];
  const noticeNote = await newNoteFromClipboard();
  await wait(800);
  const noticeText = await windows.get(noticeNote.id).webContents.executeJavaScript('document.querySelector("[data-role=status]").textContent');
  check('热键读不到图时新便签给出提示', /剪贴板里没有图片/.test(noticeText), noticeText);
  hardDelete(noticeNote.id);
  clipboard.read = origRead;

  const noKey = await runUnderstand(a.id);
  check('未配 key 时给出可读提示', noKey.ok === false && /key/i.test(noKey.error || ''), noKey.error);

  const ghost = await runUnderstand('not-a-real-id');
  check('非法 id 不崩', ghost.ok === false, ghost.error);

  store.saveConfig({ backend: 'openai', apiKey: 'sk-placeholder', baseUrl: '', model: 'some-model' });
  const noBase = await runUnderstand(a.id);
  check('缺 Base URL 时提示要填端点', noBase.ok === false && /Base URL/i.test(noBase.error || ''), noBase.error);

  await winA.webContents.executeJavaScript('document.querySelector("[data-act=settings]").click()');
  await wait(500);
  const drawer = await winA.webContents.executeJavaScript(`({
    open: document.querySelector('[data-role=drawer-collapse]').classList.contains('open') && document.querySelector('[data-role=drawer]').getBoundingClientRect().height > 0,
    baseVisible: !document.querySelector('[data-role=baseurl-field]').hidden,
    backend: document.querySelector('[data-role=backend]').value,
    baseVal: document.querySelector('[data-role=baseurl]').value,
    keyState: document.querySelector('[data-role=key-state]').textContent,
  })`);
  check('设置抽屉可打开且显示 Base URL', drawer.open && drawer.baseVisible && drawer.backend === 'openai', JSON.stringify(drawer));
  // 回归：抽屉曾把保存按钮顶出固定高度的窗口，用户填了 key 也点不到保存。
  // 展开动画 260ms + 280ms 后才 scrollIntoView，冷启动下固定等 500ms 会测到滚动前的位置——轮询等按钮滚进窗口。
  let saveGeom = null;
  for (let i = 0; i < 12; i++) {
    saveGeom = await winA.webContents.executeJavaScript(`(() => {
      const r = document.querySelector('[data-act=save-settings]').getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), innerH: innerHeight };
    })()`);
    if (saveGeom.bottom <= saveGeom.innerH && saveGeom.top >= 0) break;
    await wait(150);
  }
  check('抽屉打开后保存按钮滚进窗口内', saveGeom.bottom <= saveGeom.innerH && saveGeom.top >= 0, JSON.stringify(saveGeom));
  await winA.webContents.executeJavaScript(`document.querySelector('[data-role=key]').value = 'sk-smoke-save-test'`);
  const clickPt = await winA.webContents.executeJavaScript(`(() => {
    const r = document.querySelector('[data-act=save-settings]').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  winA.webContents.sendInputEvent({ type: 'mouseDown', x: clickPt.x, y: clickPt.y, button: 'left', clickCount: 1 });
  winA.webContents.sendInputEvent({ type: 'mouseUp', x: clickPt.x, y: clickPt.y, button: 'left', clickCount: 1 });
  await wait(600);
  const savedCfg = store.loadConfig();
  const afterSave = await winA.webContents.executeJavaScript(`({
    keyCleared: document.querySelector('[data-role=key]').value === '',
    keyState: document.querySelector('[data-role=key-state]').textContent,
  })`);
  check('真实点击保存后 key 落盘', savedCfg.apiKey === 'sk-smoke-save-test', savedCfg.apiKey ? `${savedCfg.apiKey.slice(0, 7)}…` : '(空)');
  check('保存后输入框清空并提示已配置', afterSave.keyCleared && /已配置/.test(afterSave.keyState), JSON.stringify(afterSave));
  const gate = await runUnderstand(a.id);
  check('存好 key 后识别不再卡 key 提示', gate.ok === false && !/还没配 API key/.test(gate.error || ''), gate.error);
  // 回归：并发识别只放一个请求出去；识别中便签被彻底删除时给可读错误，而不是广播 null 崩主进程。
  store.saveConfig({ baseUrl: 'https://stub.invalid/v1', apiKey: 'smoke-test' });
  const originChecks = await winA.webContents.executeJavaScript(`(async () => {
    const insecure = await window.sticky.saveSettings({ backend: 'openai', baseUrl: 'http://api.example.com/v1' });
    const same = await window.sticky.saveSettings({ backend: 'openai', baseUrl: 'https://stub.invalid/alternate/v1' });
    const changed = await window.sticky.saveSettings({ backend: 'openai', baseUrl: 'https://other.invalid/v1' });
    return { insecure: !insecure.ok, same: same.ok && same.hasKey, changed: changed.ok && !changed.hasKey };
  })()`);
  check('端点校验 HTTPS，密钥仅在同源设置中保留', originChecks.insecure && originChecks.same && originChecks.changed, JSON.stringify(originChecks));
  store.saveConfig({ baseUrl: 'https://stub.invalid/v1', apiKey: 'smoke-test' });
  const guardNote = createNote({ title: '识别守护测试', images: [saved.rel] });
  await wait(400);
  const origDescribe = ai.describe;
  let releaseStub;
  ai.describe = () => new Promise((r) => { releaseStub = r; });
  const firstCall = runUnderstand(guardNote.id);
  await wait(60);
  const secondCall = await runUnderstand(guardNote.id);
  check('同一便签并发识别被拦下', secondCall.ok === false && /正在识别/.test(secondCall.error || ''), secondCall.error);
  hardDelete(guardNote.id);
  releaseStub({ task_name: 'x', summary: '', points: [], due: null, from: null, model: 'stub' });
  const orphanCall = await firstCall;
  check('识别中便签被删返回可读错误', orphanCall.ok === false && /已不存在/.test(orphanCall.error || ''), orphanCall.error);
  ai.describe = origDescribe;
  // 多图请求体：fetch 替身截请求，不打真端点。
  const origFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, init) => {
    captured = { url: String(url), body: JSON.parse(init.body), redirect: init.redirect };
    const draftJson = JSON.stringify({ task_name: '多图', summary: '', points: [], due: null, from: null });
    const payload = String(url).includes('generativelanguage')
      ? { candidates: [{ content: { parts: [{ text: draftJson }] }, finishReason: 'STOP' }] }
      : { choices: [{ message: { content: draftJson }, finish_reason: 'stop' }] };
    return { ok: true, text: async () => JSON.stringify(payload) };
  };
  const twoImages = [{ mimeType: 'image/png', base64: 'AA==' }, { mimeType: 'image/png', base64: 'BB==' }];
  store.saveConfig({ backend: 'openai', baseUrl: 'https://stub.invalid/v1', apiKey: 'sk-stub', model: 'stub-model' });
  await ai.describe(store.loadConfig(), twoImages);
  const oaiParts = captured.body.messages[0].content.filter((p) => p.type === 'image_url');
  check('OpenAI 请求体带全部图', oaiParts.length === 2 && oaiParts[1].image_url.url.endsWith('BB=='), String(oaiParts.length));
  check('OpenAI 请求禁用重定向', captured.redirect === 'error');
  store.saveConfig({ backend: 'gemini', geminiApiKey: 'stub', model: 'stub-flash' });
  await ai.describe(store.loadConfig(), twoImages);
  const gParts = captured.body.contents[0].parts.filter((p) => p.inline_data);
  check('Gemini 请求体带全部图', gParts.length === 2 && gParts[1].inline_data.data === 'BB==', String(gParts.length));
  check('Gemini 请求禁用重定向', captured.redirect === 'error');
  global.fetch = origFetch;
  store.saveConfig({ backend: 'openai', model: '' });
  await winA.webContents.executeJavaScript(`(() => {
    const s = document.querySelector('[data-role=backend]');
    s.value = 'gemini';
    s.dispatchEvent(new Event('change'));
  })()`);
  await wait(250);
  const hiddenForGemini = await winA.webContents.executeJavaScript('document.querySelector("[data-role=baseurl-field]").hidden');
  check('切到 Gemini 时 Base URL 栏收起', hiddenForGemini === true, String(hiddenForGemini));
  await winA.webContents.executeJavaScript('document.querySelector("[data-act=settings]").click()');
  await wait(200);
  const titlePaste = await winA.webContents.executeJavaScript(`(() => {
    const t = document.querySelector('[data-role=title]');
    t.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', '纯文本');
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    t.dispatchEvent(ev);
    const ok = !ev.defaultPrevented;
    t.blur();
    return ok;
  })()`);
  check('标题框粘文本不被截图逻辑劫持', titlePaste === true, String(titlePaste));

  // 回归：粘图/拖图只加图、不自动调模型（用户嫌太主动）；点「识别」才发起识别。
  {
    let describeCalls = 0;
    const origDescribe2 = ai.describe;
    ai.describe = async () => {
      describeCalls += 1;
      return { task_name: 'stub任务', summary: '', points: [], due: null, from: null, model: 'stub' };
    };
    store.saveConfig({ backend: 'openai', baseUrl: 'https://stub.invalid/v1', apiKey: 'sk-stub', model: 'stub-model' });
    const pasteNote = createNote({ title: '粘图不自动识别' });
    await wait(900);
    const pasteWin = windows.get(pasteNote.id);
    const pngArr = [...tinyPngIcon()];
    await pasteWin.webContents.executeJavaScript(`window.__smoke.attachImage(${JSON.stringify(pngArr)})`);
    await wait(700);
    const afterPaste = await pasteWin.webContents.executeJavaScript(`({
      imgs: (window.__smoke.state().images || []).length,
      draft: window.__smoke.state().draft ? 1 : 0,
      status: document.querySelector('[data-role=status]').textContent,
    })`);
    check('粘图后自动加了 1 张图', afterPaste.imgs >= 1, JSON.stringify(afterPaste));
    check('粘图不自动发起识别', describeCalls === 0 && afterPaste.draft === 0 && /识别/.test(afterPaste.status), `calls=${describeCalls} ${JSON.stringify(afterPaste)}`);
    await pasteWin.webContents.executeJavaScript(`document.querySelector('[data-act=understand]').click()`);
    await wait(700);
    check('点识别按钮才发起识别', describeCalls === 1, `calls=${describeCalls}`);
    ai.describe = origDescribe2;
    hardDelete(pasteNote.id);
  }

  // 带真 key 的端到端只在显式打开时跑：STICKY_SMOKE_AI=1 npm run smoke
  const shotFile = path.join(OUTPUT_DIR, 'probe-shot.png');
  if (process.env.STICKY_SMOKE_AI) {
    const liveConfig = store.loadConfig({ live: true });
    if (ai.keyOf(liveConfig) && fs.existsSync(shotFile)) {
      const savedShot = saveImage(nativeImage.createFromPath(shotFile));
      patchNote(a.id, { images: [savedShot.rel], draft: null });
      const t0 = Date.now();
      const real = await runUnderstand(a.id, liveConfig);
      const name = real.ok ? real.note.draft?.task_name : real.error;
      check('真端点端到端识别', real.ok === true && Boolean(name) && name !== '无法识别的截图', `${name} · ${Date.now() - t0}ms · ${real.ok ? real.note.draft.model : ''}`);
      if (real.ok) fs.writeFileSync(path.join(OUTPUT_DIR, 'real-draft.json'), JSON.stringify(real.note.draft, null, 1));
    } else {
      console.log('SKIP  真端点自检：缺 API key 或 test-output/probe-shot.png');
    }
  }

  // ---------- 颜色 / 完成 / 回收站 ----------
  const c = createNote({ title: '换色与完成测试' });
  await wait(800);
  const winC = windows.get(c.id);
  const recolored = patchNote(c.id, { color: '#cfe3f7' });
  applyWindowSize(winC, recolored);
  broadcast(recolored);
  await wait(400);
  const cssPaper = await winC.webContents.executeJavaScript(`getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()`);
  check('换色后 CSS 底色跟着变', cssPaper === '#cfe3f7', cssPaper);
  const markedSwatch = await winC.webContents.executeJavaScript(`document.querySelector('.swatch.on')?.dataset.color`);
  check('色板高亮当前色', markedSwatch === '#cfe3f7', String(markedSwatch));
  const rejected = await winC.webContents.executeJavaScript(`window.sticky.patch(${JSON.stringify(c.id)}, { color: '#123456' }).then((n) => n.color)`);
  check('色板外的颜色被拒', rejected === '#cfe3f7', String(rejected));
  const swatchCount = await winC.webContents.executeJavaScript(`document.querySelectorAll('.swatch').length`);
  check('色板渲染出 5 个圆点', swatchCount === PALETTE.length, String(swatchCount));
  store.saveConfig({ noteColor: '#123456' });
  const fallbackNote = createNote({ title: '默认色兜底' });
  check('配置里的野颜色兜底回色板', fallbackNote.color === PALETTE[0].bg, fallbackNote.color);
  hardDelete(fallbackNote.id);

  completeNote(c.id);
  await wait(500);
  check('完成后窗口自动关闭', windows.has(c.id) === false, '');
  check('完成后不再占桌面', store.liveNotes(allNotes()).some((n) => n.id === c.id) === false, '');
  check('完成后进入已完成', store.doneNotes(allNotes()).some((n) => n.id === c.id && n.doneAt > 0), '');
  bringBack(c.id, { done: false, doneAt: null });
  await wait(700);
  check('取消完成后重新开窗', windows.get(c.id) && !windows.get(c.id).isDestroyed(), '');
  check('取消完成回到未完成', store.liveNotes(allNotes()).some((n) => n.id === c.id), '');

  trashNote(c.id);
  await wait(500);
  check('删除进回收站而不是消失', allNotes().some((n) => n.id === c.id) && store.trashedNotes(allNotes()).some((n) => n.id === c.id), '');
  bringBack(c.id, { deleted: false, deletedAt: null });
  await wait(600);
  check('回收站恢复成功', store.liveNotes(allNotes()).some((n) => n.id === c.id), '');

  // 截图按哈希共用：只有最后一条引用被彻底删除时才该删文件
  const relX = store.saveImage(Buffer.from('refcount-x')).rel;
  const d1 = createNote({ title: '共用截图 1', images: [relX] });
  const d2 = createNote({ title: '共用截图 2', images: [relX] });
  await wait(700);
  hardDelete(d1.id);
  check('仍有引用时不删截图文件', fs.existsSync(path.join(store.DATA_DIR, relX)), relX);
  hardDelete(d2.id);
  check('最后一个引用消失后删文件', !fs.existsSync(path.join(store.DATA_DIR, relX)), relX);
  check('彻底删除后记录也不在文件里', !allNotes().some((n) => n.id === d1.id || n.id === d2.id), '');

  const doomed = createNote({ title: '超期待清' });
  await wait(500);
  trashNote(doomed.id);
  patchNote(doomed.id, { deletedAt: Date.now() - (TRASH_KEEP_DAYS + 1) * 864e5 });
  const pr = store.purgeTrash(allNotes(), TRASH_KEEP_DAYS);
  store.saveNotes(pr.remaining);
  check('回收站超期被清理', pr.purged === 1 && !allNotes().some((n) => n.id === doomed.id), `purged=${pr.purged}`);

  // 留一条已完成 + 一条回收站，验证归档窗口列得出来
  const keeper = createNote({ title: '这条会被完成' });
  await wait(500);
  completeNote(keeper.id);
  const inTrash = createNote({ title: '这条在回收站' });
  await wait(500);
  trashNote(inTrash.id);
  await wait(300);

  openArchiveWindow();
  await wait(1200);
  const counts = await archiveWin.webContents.executeJavaScript(`({
    done: document.querySelector('[data-role=done-count]').textContent,
    trash: document.querySelector('[data-role=trash-count]').textContent,
    rows: document.querySelectorAll('.row').length,
    struck: document.querySelectorAll('.name.struck').length,
    keepDays: document.querySelector('[data-role=keep-days]').textContent,
  })`);
  check(
    '归档窗口列出已完成与回收站',
    Number(counts.done) === store.doneNotes(allNotes()).length && Number(counts.trash) === store.trashedNotes(allNotes()).length && counts.rows === 2,
    JSON.stringify(counts),
  );
  check('已完成条目带删除线', counts.struck === 1, String(counts.struck));
  const deco = await archiveWin.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.name.struck')).textDecorationLine`);
  check('删除线样式真的生效', deco === 'line-through', deco);
  const dotColor = await archiveWin.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.row .dot')).backgroundColor`);
  check('归档行显示便签原色', dotColor === 'rgb(249, 232, 166)', dotColor);
  check('保留天数写进 UI', counts.keepDays === String(TRASH_KEEP_DAYS), counts.keepDays);
  const shotArchive = await archiveWin.webContents.capturePage();
  fs.writeFileSync(path.join(OUTPUT_DIR, '03-archive.png'), shotArchive.toPNG());

  broadcast(findNote(a.id));
  await wait(300);
  const shotExpanded = await winA.webContents.capturePage();
  fs.writeFileSync(path.join(OUTPUT_DIR, '01-expanded.png'), shotExpanded.toPNG());
  await winA.webContents.executeJavaScript('window.__smoke.fold(true)');
  await wait(700);
  const shotFolded = await winA.webContents.capturePage();
  fs.writeFileSync(path.join(OUTPUT_DIR, '02-collapsed.png'), shotFolded.toPNG());
  check('视觉产物已写盘', fs.existsSync(path.join(OUTPUT_DIR, '02-collapsed.png')), OUTPUT_DIR);
  check('渲染层零报错（含 CSP 违规）', rendererErrors.length === 0, rendererErrors.slice(0, 3).join(' | '));
}

// ---------- 生命周期 ----------

if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    registerIpc();
    buildTray();
    registerShortcuts();
    // 首次运行（还没有 notes.json）必须留一张可见的便签：
    // 否则双击 exe 后屏幕上什么都没有，只有个托盘图标，像是没启动。
    const firstRun = !fs.existsSync(store.NOTES_FILE);
    const purged = store.purgeTrash(allNotes(), TRASH_KEEP_DAYS);
    if (purged.purged) {
      store.saveNotes(purged.remaining);
      console.log(`[main] 回收站超 ${TRASH_KEEP_DAYS} 天，清了 ${purged.purged} 条（释放截图 ${purged.imagesFreed} 个）`);
    }
    for (const note of store.liveNotes(allNotes())) openNoteWindow(note);
    if (firstRun && !SMOKE) createNote({ title: '欢迎：这就是一张便签', body: WELCOME });
    if (SMOKE) await runSmoke();
  });

  app.on('second-instance', () => showAllWindows());
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('window-all-closed', () => {
    if (!quitting && !SMOKE && tray) return;
    app.quit();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
