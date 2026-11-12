'use strict';

// 模型偶尔会包 ```json 或前后加话，取第一个 { 到最后一个 } 再解析。
function parseJsonLoose(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`模型没有返回 JSON：${cleaned.slice(0, 200)}`);
  return JSON.parse(cleaned.slice(start, end + 1));
}

module.exports = { parseJsonLoose };
