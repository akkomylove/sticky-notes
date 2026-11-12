'use strict';

// 预设色板：正文 #35301c 在这五个底色上最低 9.22:1，次要文字 #5d5538 最低 5.20:1，都过 WCAG AA。
// 想加颜色就照这个对比度门槛挑，别拿纯白纯灰直接上。
const PALETTE = [
  { name: '黄', bg: '#f9e8a6' },
  { name: '粉', bg: '#f8cdd4' },
  { name: '蓝', bg: '#cfe3f7' },
  { name: '绿', bg: '#d5eed0' },
  { name: '紫', bg: '#e2d7f5' },
];

const DEFAULT_COLOR = PALETTE[0].bg;

function isColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || ''));
}

function normalizeColor(value) {
  return isColor(value) ? String(value).toLowerCase() : DEFAULT_COLOR;
}

module.exports = { PALETTE, DEFAULT_COLOR, isColor, normalizeColor };
