/**
 * attach-plan.mjs —— 把出图单按 tag 合进盘点 JSON，build 时在页面的「提示词」页显示。
 *
 * 用法：
 *   node scripts/attach-plan.mjs <盘点.json> <清单.json> [<清单2.json> …] <输出.json>
 *
 * 清单是 { "<tag>": { 字段: 值 } }，只认这三个字段（都是 art-designer 写的）：
 *   prompt    出图提示词
 *   size      出图尺寸，"宽x高" 像素，如 "3136x1344"
 *   refImage  参考图 tag 数组，按 <Picture 1>、<Picture 2>… 的顺序
 * 两个保留键（字符串）：
 *   "_note"    整份出图单的通用说明 → meta.renderNote，显示在「提示词」页顶部（模型参数、参考图怎么处理）
 *   "_design"  整部戏共用的设计约定 → meta.designNote，也显示在「提示词」页顶部
 *              （全剧坐标、同一栋建筑的共用约定、特效语言 —— 写一次，不在每条提示词里重抄）
 * 可以给几份清单（比如重抽时另写一份补丁）；同一个 tag 后给的覆盖先给的同名字段。
 * tag 可以是场景、服装、道具、特效，以及它们的变体。
 *
 * 输出另存一份 JSON，不覆盖原盘点。之后再跑 attach-images.mjs 挂图、build.mjs 出页面。
 *
 * ★ 盘点里没有的 tag、不认识的字段，一律报错退出 —— 拼错一个字，那条提示词就悄悄丢了。
 *   旧版的 design 字段（单独的设计稿）已经不用：设计师直接出提示词。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error('用法：node scripts/attach-plan.mjs <盘点.json> <清单.json> [<清单2.json> …] <输出.json>');
  process.exit(2);
}
const [jsonPath, ...rest] = args;
const outPath = rest.pop();
const D = JSON.parse(readFileSync(jsonPath, 'utf8'));

const byTag = {};
for (const k of ['assets', 'characters', 'outfits', 'props', 'effects'])
  (D[k] || []).forEach((a) => { byTag[a.tag] = a; (a.variants || []).forEach((v) => { byTag[v.tag] = v; }); });

const FIELDS = ['prompt', 'size', 'refImage'];
const errs = [];
let n = 0;
for (const f of rest) {
  const M = JSON.parse(readFileSync(f, 'utf8'));
  for (const [tag, rec] of Object.entries(M)) {
    if (tag === '_note') { D.meta.renderNote = rec; continue; }
    if (tag === '_design') { D.meta.designNote = rec; continue; }
    const item = byTag[tag];
    if (!item) { errs.push(`${f} · ${tag}：盘点里没有这个 tag`); continue; }
    for (const [k, v] of Object.entries(rec)) {
      if (!FIELDS.includes(k)) { errs.push(`${f} · ${tag}：不认识的字段 ${k}（只认 ${FIELDS.join(' / ')}）`); continue; }
      item[k] = v;
    }
    n++;
  }
}
if (errs.length) { console.error('✗ 有 ' + errs.length + ' 处没合上：\n  ' + errs.join('\n  ')); process.exit(1); }
writeFileSync(outPath, JSON.stringify(D, null, 2), 'utf8');
console.log(`✓ 合了 ${n} 条 → ${resolve(outPath)}`);
