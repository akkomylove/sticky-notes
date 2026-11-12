'use strict';

const gemini = require('./gemini');
const openai = require('./openai');

function keyOf(cfg) {
  return cfg.backend === 'gemini' ? cfg.geminiApiKey : cfg.apiKey;
}

async function resolveModel(cfg) {
  if (cfg.backend === 'gemini') return gemini.resolveModel(cfg.geminiApiKey, cfg.model);
  return openai.resolveModel(cfg);
}

// UI 只关心「有哪些能填的模型」，两个后端整理成同一个形状。
async function listModels(cfg) {
  if (cfg.backend === 'gemini') {
    const all = await gemini.listModels(cfg.geminiApiKey);
    return { candidates: gemini.rankFlashModels(all).slice(0, 10), total: all.length };
  }
  const all = await openai.listModels(cfg);
  return { candidates: openai.rankModels(all, cfg.model).slice(0, 10), total: all.length };
}

async function describe(cfg, images) {
  const model = await resolveModel(cfg);
  if (cfg.backend === 'gemini') {
    return gemini.understandScreenshot({ key: cfg.geminiApiKey, model, images });
  }
  return openai.understandScreenshot({
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model,
    images,
  });
}

module.exports = { keyOf, resolveModel, listModels, describe };
