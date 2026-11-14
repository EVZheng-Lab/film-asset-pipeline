# ad-asset-bible（副导演-资产盘点）· film-asset-pipeline 版

把一份剧本变成一份**资产盘点**：几处地方、几个人几套衣服、几件跨场景的道具、几个会重复出现的特效，
每份几个变体、每场戏用哪一个；另给每个角色写一份角色档案（怎么演、说话什么声）。
产出是 JSON + 一个自包含网页，交给同仓库的 art-designer（设计）和 h3-image-film-assets（提示词、出图）。
整条流水线怎么跑见仓库根目录 `PIPELINE.md`；agent 的操作规则见 `SKILL.md`。

跟独立发布的 ad-asset-bible 的区别：盘完不停下等审阅；角色出图先出脸图、所有服装和状态变体都参考脸图；
支持衍生场景（`basedOn`）、场景里的人物形象（`refs`）、同脸不同人（`sameFaceAs`）、空镜（`emptyShots`）、
以及合并设计稿与出图单的三阶段页面。

## 目录

```
ad-asset-bible/
├── SKILL.md                         # agent 的流程与规则
├── references/
│   ├── how-to-write.md              # 定调性 / 切场景 / 去重 / 场景描述 / 参照物 / 场景变体
│   ├── how-to-write-character.md    # 角色底档与服装
│   ├── how-to-write-prop-vfx.md     # 道具（含 refs）与特效
│   └── how-to-write-bio.md          # 角色档案
├── scripts/
│   ├── build.mjs                    # JSON → HTML，含结构预检（闸门）
│   ├── attach-plan.mjs              # 合进设计稿与出图单
│   ├── attach-images.mjs            # 挂成图（清单或 ComfyUI PNG 文件夹）
│   ├── check-sync.mjs               # 外壳与 build.mjs 的常量同步检查
│   └── make-test.mjs                # 闸门验收（非运行时）
├── templates/report-shell.html      # 静态外壳，顶部注释是数据契约
└── tests/fixtures/                  # 合规样本与违规样本
```

需要 Node.js（ESM `.mjs`，无第三方依赖；挂图用 ffmpeg）。脚本用 `import.meta.url` 自定位，从任何目录调都行。

```bash
node scripts/check-sync.mjs && node scripts/make-test.mjs   # 装完或改完闸门后跑一次
```

## 页面

顶上三个阶段大 Tab：**需求清单 / 美术设计 / 提示词**。需求清单下五个小 Tab：场景 / 角色 · 服装 / 关键道具 / 特效 / 角色档案。
每行的「复制」只给内容本身（不带 tag、场次这类账目），服装格自动拼上底档。档案按阶段各给一个复制按钮，
拿到的是"开场 + 累积到这一段的变化"。网页只给电脑用，不考虑手机。

深链：`?stage=need|design|prompt`、`?tab=loc|char|prop|vfx|bio|all`、`?row=N`、`?selftest=1`（显示自检横条）。

## 维护备注

- **校验常量在 `build.mjs` 与 `templates/report-shell.html` 各存一份**（自包含 HTML 无法 import）。改一处必须同步另一处，
  跑 `check-sync.mjs`（自动发现 build.mjs 里的 ALL_CAPS 常量并逐项比对，也查数据契约注释里的必填字段）。
  它的必填字段表带引号写（`"char"`），因为裸写的短字段名会被 `charCount` 之类包含掉、变成永真。
- **tag 格式正则刻意内联**，不提成 ALL_CAPS 常量：那样 check-sync 会要求外壳也有一份，而标签格式只该在 build.mjs 拦。
- **`{{DATA_JSON}}` 在外壳里只能出现一次**（`String.replace` 只换第一处），外壳注释刻意不写这个字面量，build 注入后断言无残留。
- **SELFTEST badge 与 build.mjs 分工**：「这份产出缺不缺东西」两边都查（badge 一眼看出够不够格）；
  账目结构（标签格式、重复、计数、指向、跨场景门槛）只在 build.mjs 查，不合格生不出页面。
  badge 的 `bio` / `bio-lane` / `bio-arc` / `bio-pair` 分四项，是因为改法各不相同（补写 / 删掉换成行为 / 挪到对的时期 / 补一份或并掉）。
- **需求描述不许扩张成规格书。** 曾给每个场景写上千字规格并逐项加闸门，图越来越差；`BRIEF_MAX` 300 字是质量上限。
  区分两种闸门：**字段闸门**（必须写到多细）会把描述逼成规格书，禁止扩张；**类型分派与交叉引用完整性**（PEOPLE 只管场景、
  refs 指到服装级、场次必须在场景表里）随资产类型增加是该有的。角色档案的逐块闸门不受前一条限制：档案不喂图像模型，
  而 ACTING 的每条"必须"不逐块上闸门就没人守。
- **"被声明为必须、却没有闸门"的规则最危险**（参照物当年就是这么被编造出来的）；反过来，**必写的东西已被另一条必写项覆盖时，
  别再加闸门**（服装的参照物闸门就因为逼出复述痕迹的废句而撤掉了）。
- **规则本身也会错**：曾写"档案是全片恒定的底本"，对有弧光的角色是假的，于是有了 `arc[]`。
  每一句"恒定 / 唯一 / 永不"，要问是不是对每个输入都成立。
- **`arc` 的场次分配闸门守的是分工**（从第几场起用哪个阶段归导演），跟其余守"该做的做全没有"的闸门方向相反。
- **双向墙、时间墙两边都要有用例**：`char-emotion` / `char-trait` 守出图资产不写性格，`bio-wardrobe` / `bio-downstream` 守档案不写外观和机位；
  `bio-drift-in-base` 守八块不写后来的变化，`bio-arc-schedule*` 守 arc 不替导演分配场次。
- **词表误伤走豁免，不改正确的内容**：`DOWNSTREAM_OK` 先把整个长词抠掉再匹配（"彩色相纸"放过、"色相"照拦），
  加词的判据是"这是画面里看得见的东西名，不是色彩/机位决策"；豁免由 `ok-exempt-words` 用例守着。
- 特效没写进 `ok.json`（那份样本是当代写实世界观），由 make-test 里的 `withVfx()` 现挂。

## License

MIT
