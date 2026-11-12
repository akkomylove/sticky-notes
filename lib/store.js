const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_COLOR, normalizeColor } = require('./palette');
const { baseUrlOrigin } = require('./openai');

// 代码目录：打包后在 app.asar 里，只读，只能拿来 loadFile / preload。
const ROOT = path.join(__dirname, '..');
// 可写目录：开发时等于项目根；打包后由主进程设成 exe 所在目录，
// 这样便携版把便签、截图、key 都留在 exe 旁边，拷走就是整个迁移。
const HOME = process.env.STICKY_NOTES_HOME ? path.resolve(process.env.STICKY_NOTES_HOME) : ROOT;
// 自检目录也挂在 HOME 下，打包后的 exe 才能自己跑 smoke（asar 里写不了盘）。
const SMOKE = process.argv.includes('--smoke');
const DATA_DIR = SMOKE
  ? path.join(HOME, 'test-output', 'data')
  : path.resolve(process.env.STICKY_NOTES_DATA || path.join(HOME, 'data'));
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const MAX_IMAGES = 5;
const NOTES_FILE = path.join(DATA_DIR, 'notes.json');
// key 跟着 data/ 走，smoke 用隔离目录时不会读到真实 key。
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

fs.mkdirSync(IMAGES_DIR, { recursive: true });

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[store] read failed', file, err.message);
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const DEFAULT_CONFIG = {
  backend: 'openai',
  baseUrl: '',
  apiKey: '',
  model: '',
  geminiApiKey: '',
  noteColor: DEFAULT_COLOR,
};

function loadConfig({ live = false } = {}) {
  const file = live && SMOKE ? path.join(HOME, 'data', 'config.json') : CONFIG_FILE;
  const stored = readJsonSafe(file, {});
  const cfg = { ...DEFAULT_CONFIG, ...stored };
  if (!SMOKE || live) {
    const envBaseUrl = process.env.OPENAI_BASE_URL;
    if (envBaseUrl) {
      const storedOrigin = baseUrlOrigin(cfg.baseUrl);
      if (!storedOrigin || storedOrigin !== baseUrlOrigin(envBaseUrl)) cfg.apiKey = '';
      cfg.baseUrl = envBaseUrl;
    }
    cfg.apiKey = process.env.OPENAI_API_KEY || cfg.apiKey;
    cfg.geminiApiKey = process.env.GEMINI_API_KEY || cfg.geminiApiKey;
  }
  return cfg;
}

function saveConfig(patch) {
  const stored = readJsonSafe(CONFIG_FILE, {});
  const merged = { ...stored, ...patch };
  if (patch.baseUrl !== undefined && patch.baseUrl !== stored.baseUrl && patch.apiKey === undefined) {
    const previousOrigin = baseUrlOrigin(stored.baseUrl);
    if (!previousOrigin || previousOrigin !== baseUrlOrigin(patch.baseUrl)) merged.apiKey = '';
  }
  writeJsonAtomic(CONFIG_FILE, merged);
  return merged;
}

function loadNotes() {
  const raw = readJsonSafe(NOTES_FILE, []);
  if (!Array.isArray(raw)) return [];
  return raw.map((n) => normalizeNote(n));
}

function saveNotes(notes) {
  writeJsonAtomic(NOTES_FILE, notes);
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function normalizeNote(n) {
  return {
    id: n.id || newId(),
    title: n.title || '',
    body: n.body || '',
    color: normalizeColor(n.color),
    collapsed: Boolean(n.collapsed),
    x: Number.isFinite(n.x) ? n.x : null,
    y: Number.isFinite(n.y) ? n.y : null,
    pinned: n.pinned !== false,
    // 旧版单图字段 image 在读盘时迁进数组，落盘只写 images。
    images: (Array.isArray(n.images) ? n.images : n.image ? [n.image] : [])
      .filter((r) => typeof r === 'string' && r)
      .slice(0, MAX_IMAGES),
    draft: n.draft || null,
    done: Boolean(n.done),
    doneAt: Number.isFinite(n.doneAt) ? n.doneAt : null,
    deleted: Boolean(n.deleted),
    deletedAt: Number.isFinite(n.deletedAt) ? n.deletedAt : null,
    createdAt: n.createdAt || Date.now(),
    updatedAt: n.updatedAt || Date.now(),
  };
}

const liveNotes = (all) => all.filter((n) => !n.done && !n.deleted);
const doneNotes = (all) => all.filter((n) => n.done && !n.deleted).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
const trashedNotes = (all) => all.filter((n) => n.deleted).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));

// 回收站超期的条目彻底删除；图片按哈希共用，只有没人引用了才删文件。
function purgeTrash(all, keepDays = 30) {
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const expired = all.filter((n) => n.deleted && (n.deletedAt || 0) < cutoff);
  if (!expired.length) return { remaining: all, purged: 0, imagesFreed: 0 };
  const kept = all.filter((n) => !expired.includes(n));
  const stillReferenced = new Set(kept.flatMap((n) => n.images));
  let imagesFreed = 0;
  const freed = new Set();
  for (const n of expired) {
    for (const rel of n.images) {
      if (freed.has(rel) || stillReferenced.has(rel)) continue;
      freed.add(rel);
      const abs = resolveImage(rel);
      if (!abs) continue;
      try {
        fs.unlinkSync(abs);
        imagesFreed += 1;
      } catch (err) {
        if (err.code !== 'ENOENT') console.error('[store] purge image failed', err.message);
      }
    }
  }
  return { remaining: kept, purged: expired.length, imagesFreed };
}

// 图片以 content-hash 命名，同一张截图重复粘贴只落盘一次。
function saveImage(buffer) {
  const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16);
  const name = `${hash}.png`;
  const file = path.join(IMAGES_DIR, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buffer);
  return { rel: `images/${name}`, bytes: buffer.length, hash };
}

// 所有截图路径消费点都走这里：notes.json 可能被手改，IPC 也可能传任意字符串，
// 越出 images/ 的一律拒绝，否则 unlink/openPath 会碰到数据目录外的文件。
function resolveImage(rel) {
  if (!rel || typeof rel !== 'string') return null;
  const abs = path.join(DATA_DIR, path.normalize(rel));
  return abs.startsWith(IMAGES_DIR + path.sep) ? abs : null;
}

function readImageAsDataUrl(rel) {
  const abs = resolveImage(rel);
  if (!abs) return null;
  try {
    return 'data:image/png;base64,' + fs.readFileSync(abs).toString('base64');
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[store] image read failed', err.message);
    return null;
  }
}

module.exports = {
  ROOT,
  HOME,
  DATA_DIR,
  IMAGES_DIR,
  MAX_IMAGES,
  NOTES_FILE,
  CONFIG_FILE,
  loadConfig,
  saveConfig,
  loadNotes,
  saveNotes,
  liveNotes,
  doneNotes,
  trashedNotes,
  purgeTrash,
  newId,
  normalizeNote,
  saveImage,
  readImageAsDataUrl,
  resolveImage,
};
