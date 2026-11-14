/**
 * attach-images.mjs —— 把出好的资产图挂回盘点 JSON，build 时在页面上显示成缩略图。
 *
 * 用法：
 *   node scripts/attach-images.mjs <盘点.json> <图片清单.json> <输出.json>
 *   node scripts/attach-images.mjs <盘点.json> <图片文件夹>    <输出.json>
 *
 * 图片清单是 { "<tag>": "<图片路径>" }，tag 可以是：
 *   场景 / 场景变体 / 角色底档（放脸图）/ 服装 / 服装状态变体 / 道具 / 道具变体 / 特效 / 特效变体。
 * 路径相对图片清单所在目录，或写绝对路径。
 *
 * 每张图用 ffmpeg 缩成宽 1280 的 JPEG，以 data URI 写进对应条目的 `image` 字段 ——
 * 页面是单文件、要能整份发给别人，所以图跟着页面走，不引用本机路径。
 * 输出另存一份 JSON，不覆盖原盘点。
 *
 * 第二种用法给"图是自己手动存的、文件名没规律"的情况：脚本读文件夹里每张 PNG
 * 嵌着的出图参数（ComfyUI 存图默认会把整个工作流连同提示词写进 PNG），
 * 拿里面的文字跟盘点里各条的 prompt 比对，一样的就配上。前提是盘点已经合过出图单
 * （attach-plan.mjs），条目上有 prompt。转成 JPG、截图、网页版工具出的图都没有这份信息，
 * 配不上的就在网页「提示词」页里手动拖。同一个提示词出了几张（重抽）时取最新的一张。
 *
 * ★ 盘点里没有的 tag、找不到的文件，一律报错退出，不静默跳过 —— 贴错一张比漏贴一张更难发现。
 *   文件夹模式例外：配不上的图只列出来，不报错 —— 文件夹里本来就可能有别的图。
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const [jsonPath, mapPath, outPath] = process.argv.slice(2);
if (!jsonPath || !mapPath || !outPath) {
  console.error('用法：node scripts/attach-images.mjs <盘点.json> <图片清单.json> <输出.json>');
  process.exit(2);
}
const D = JSON.parse(readFileSync(jsonPath, 'utf8'));
const isDir = statSync(mapPath).isDirectory();
const base = isDir ? resolve(mapPath) : dirname(resolve(mapPath));

// tag → 条目对象（主资产和变体都收）
const byTag = {};
const take = (list) => (list || []).forEach((a) => {
  byTag[a.tag] = a;
  (a.variants || []).forEach((v) => { byTag[v.tag] = v; });
});
take(D.assets); take(D.characters); take(D.outfits); take(D.props); take(D.effects);

/* PNG 里的文字块（tEXt / zTXt / iTXt）→ 里面所有字符串。JSON 就展开取全部字符串值 */
function pngTexts(file) {
  const b = readFileSync(file), out = [];
  if (b.toString('latin1', 1, 4) !== 'PNG') return out;
  for (let o = 8; o + 8 <= b.length;) {
    const len = b.readUInt32BE(o), type = b.toString('latin1', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + len);
    try {
      const z = d.indexOf(0);
      if (type === 'tEXt') out.push(d.toString('latin1', z + 1));
      else if (type === 'zTXt') out.push(inflateSync(d.subarray(z + 2)).toString('latin1'));
      else if (type === 'iTXt') {
        const comp = d[z + 1];
        let p = z + 3; p = d.indexOf(0, p) + 1; p = d.indexOf(0, p) + 1;   // 跳过语言标签、译名
        const body = d.subarray(p);
        out.push((comp ? inflateSync(body) : body).toString('utf8'));
      }
    } catch { /* 坏块跳过 */ }
    if (type === 'IEND') break;
    o += 12 + len;
  }
  const strs = [];
  const walk = (v) => { if (typeof v === 'string') strs.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  for (const t of out) { try { walk(JSON.parse(t)); } catch { strs.push(t); } }
  return strs;
}
const norm = (t) => String(t).replace(/\s+/g, ' ').trim();

let MAP;
if (!isDir) MAP = JSON.parse(readFileSync(mapPath, 'utf8'));
else {
  const want = Object.values(byTag).filter((a) => a.prompt).map((a) => [a.tag, norm(a.prompt)]);
  if (!want.length) { console.error('盘点里没有一条带 prompt —— 先用 attach-plan.mjs 合出图单，才能按提示词配图。'); process.exit(2); }
  const hit = {}, miss = [];
  for (const f of readdirSync(base).filter((f) => /\.png$/i.test(f))) {
    const full = join(base, f), strs = pngTexts(full).map(norm);
    const m = want.find(([, p]) => strs.some((s) => s === p)) || want.find(([, p]) => strs.some((s) => s.includes(p)));
    if (!m) { miss.push(f); continue; }
    const t = statSync(full).mtimeMs;
    (hit[m[0]] = hit[m[0]] || []).push([t, full]);
  }
  MAP = {};
  for (const [tag, list] of Object.entries(hit)) {
    list.sort((a, b) => b[0] - a[0]);
    MAP[tag] = list[0][1];
    if (list.length > 1) console.log(`  ${tag}：同一个提示词有 ${list.length} 张，取最新的 ${list[0][1]}`);
  }
  console.log(`按提示词配上 ${Object.keys(MAP).length} 张；${miss.length} 张 PNG 配不上${miss.length ? '：' + miss.slice(0, 12).join('、') + (miss.length > 12 ? ' …' : '') : ''}`);
  const still = want.filter(([t]) => !MAP[t] && !byTag[t].image).map(([t]) => t);
  if (still.length) console.log(`还没有图的：${still.join(' ')} —— 到网页「提示词」页里手动拖`);
}

try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); }
catch { console.error('需要 ffmpeg（在 PATH 里）来缩图。'); process.exit(2); }

const tmp = mkdtempSync(join(tmpdir(), 'aab-img-'));
const errs = [];
let n = 0;
for (const [tag, rel] of Object.entries(MAP)) {
  const item = byTag[tag];
  const file = resolve(base, rel);
  if (!item) { errs.push(`${tag}：盘点里没有这个 tag`); continue; }
  if (!existsSync(file)) { errs.push(`${tag}：找不到文件 ${file}`); continue; }
  const jpg = join(tmp, `${n}.jpg`);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-threads', '2', '-i', file,
    '-vf', 'scale=1280:-2:flags=area', '-q:v', '4', jpg]);
  item.image = 'data:image/jpeg;base64,' + readFileSync(jpg).toString('base64');
  n++;
}
rmSync(tmp, { recursive: true, force: true });
if (errs.length) { console.error('✗ 有 ' + errs.length + ' 处没挂上：\n  ' + errs.join('\n  ')); process.exit(1); }
writeFileSync(outPath, JSON.stringify(D, null, 2), 'utf8');
console.log(`✓ 挂了 ${n} 张图 → ${resolve(outPath)}`);
