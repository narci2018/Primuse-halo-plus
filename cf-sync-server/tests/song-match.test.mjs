// 「同一首歌 + 同一位演唱者」判据的看守（纯函数，不联网，CI 直接跑）。
//
//   node tests/song-match.test.mjs
//
// 为什么单独钉这个文件：批量换源（scripts/repoint-dead-songs.mjs）会把用户歌单里的条目
// 删掉换成别家线路的同名歌 —— 判据松一格就是"换了一首别人的歌，原来那条还删了"。
// 现网真实事故：`小幸运 / 田馥甄` 的候选里有一条歌手写 `田馥甄的小迷妹`（翻唱者的艺名），
// 旧的"整串互相包含"判据收了它，报告看着完全合理。所以这里既钉"该认的要认"，
// 也钉**"不该认的必须不认"** —— 只钉前者，把判据改回包含也照样全绿。
//
// 变异自查（改坏判据时这里必须变红）：
//   - artistHit 退回子串包含 → 「田馥甄 ↔ 田馥甄的小迷妹」「谢安琪 ↔ 谢安琪Kay」两条 FAIL；
//   - artistSegments 不摊平括号 → 「等什么君(邓寓君) ↔ 邓寓君」FAIL；
//   - titleTier 去掉 relaxed 档 → 「我的梦 ↔ 我的梦 (Live)」FAIL；
//   - sameSongAs 退回只看标题字符串 → 「同一个 netease id、标题差个（R&B版）」FAIL（现网那 3 条同 id 重复的成因）；
//   - dedupeById 不去重 → 「去重后条数 / 重复品计数」FAIL。

import { norm, baseTitle, artistSegments, artistHit, artistMatchLabel, titleTier, songKeyOf, sameKeyAs, sameSongAs, sameSongIn, dedupeById } from "../scripts/lib/song-match.mjs";

let pass = 0;
const fails = [];
const check = (label, got, want) => {
  const ok = got === want;
  if (ok) pass += 1;
  else fails.push(`${label} —— 期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`);
};

// ---- 演唱者：该认的（合作署名、括号本名、cover 署名、大小写与空白差异） ----
check("同名同歌手", artistHit("谢安琪", "谢安琪"), true);
check("合作署名里带原唱（画心那种 4 人串）", artistHit("张靓颖", "张靓颖, 卢昶宇, 王艺陶, 李秉成"), true);
check("原唱排在后面（心经：张智霖, 王菲）", artistHit("王菲", "张智霖, 王菲"), true);
check("括号里的本名算一段", artistHit("等什么君(邓寓君)", "等什么君"), true);
check("反过来只写本名也认", artistHit("等什么君(邓寓君)", "邓寓君"), true);
check("英文艺名在括号里", artistHit("李蕙敏", "李蕙敏(rainlee)"), true);
check("cover 署名", artistHit("善丹卓玛", "善丹卓玛 (cover: 心见)"), true);
check("对唱分隔符 / 与 , 等价", artistHit("庄众/李翠华", "庄众,李翠华"), true);
check("feat. 后面的合作者不影响", artistHit("Jroc Obama", "Jroc Obama, XO"), true);
check("空白与大小写差异", artistHit(" San Ale ", "San Ale"), true);

// ---- 演唱者：不该认的（这几条是整个判据的全部价值） ----
check("翻唱者的艺名里含着原唱名 —— 必须不认", artistHit("田馥甄", "田馥甄的小迷妹"), false);
check("艺名把原唱名当前缀 —— 必须不认", artistHit("谢安琪", "谢安琪Kay"), false);
check("同名不同人", artistHit("王娜", "瓦特"), false);
check("中英艺名互认不归这里管（宁可留着不换）", artistHit("A-Lin", "黄丽玲"), false);
check("伪歌手标签不相认（佛教歌曲 ≠ 佛教音乐）", artistHit("佛教歌曲", "佛教音乐"), false);
check("空串不算命中", artistHit("", ""), false);

// ---- 标题：两档 ----
check("完全同名 = exact", titleTier("失恋无罪", "失恋无罪"), "exact");
check("只差括号里的版本说明 = relaxed", titleTier("我的梦 (Live)", "我的梦"), "relaxed");
check("多个括号段也能摊平后相等", titleTier("黄昏（纵然青丝如霜）（R&B版）", "黄昏（纵然青丝如霜）"), "relaxed");
check("副标题不是括号 —— 不认", titleTier("一夜凉风起 人间又一秋", "一夜凉风起"), "");
check("live 版当原始标题写也认得出 relaxed", titleTier("失恋无罪 live", "失恋无罪"), "");

// ---- 规范化与切段本身（判据的地基） ----
check("norm 去空白标点并转小写", norm("  A-Lin 、 邓寓君 "), "alin邓寓君");
check("baseTitle 去括号段", baseTitle("赤伶 (live)"), "赤伶");
check("切段数量", artistSegments("张靓颖, 卢昶宇/王艺陶").length, 3);
check("报告要说清认的是哪一段", artistMatchLabel("张智霖, 王菲", "王菲"), "王菲");
check("没命中时给的是两边原文", artistMatchLabel("田馥甄", "田馥甄的小迷妹"), "田馥甄|田馥甄的小迷妹");

// ---- 身份：同一个条目 / 同一首歌（这一轮加的，之前只有标题字符串可比） ----
// 现网事故：`黄昏（纵然青丝如霜）` 那条 QQ 换出来的 netease id，跟用户自己早就加过的
// `黄昏（纵然青丝如霜）（R&B版）` 是**同一个** netease:3391575975。只比标题认不出括号差异，
// 同一个 id 就在同一个歌单里出现了两遍。所以身份必须先看 `platform:rawID`。
check("线上形状的身份键", songKeyOf({ id: "agg_netease_3391575975" }), "netease:3391575975");
check("本机形状的身份键（大小写归一）", songKeyOf({ platform: "QQ", rawID: "004TXgZ41ST7lB" }), "qq:004TXgZ41ST7lB");
check("本地文件条目没有身份键（不参与去重）", songKeyOf({ id: "local-D:/music/a.mp3", title: "黄昏" }), "");
check("同一个 id 就是同一首，标题差个括号也算", sameKeyAs(
  { id: "agg_netease_3391575975", title: "黄昏（纵然青丝如霜）" },
  { id: "agg_netease_3391575975", title: "黄昏（纵然青丝如霜）（R&B版）" }), true);
check("不同平台的不同 id 不是同一个条目", sameKeyAs({ id: "agg_qq_1" }, { id: "agg_netease_1" }), false);
check("跨平台同名同歌手 = 同一首歌的另一个版本", sameSongAs(
  { id: "agg_qq_111", title: "小幸运", artist: "田馥甄" },
  { id: "agg_netease_222", title: "小幸运", artist: "田馥甄" }), true);
check("id 相同即同一首（标题歌手都不必看）", sameSongAs(
  { id: "agg_netease_3391575975", title: "黄昏（纵然青丝如霜）", artist: "落日微醺" },
  { id: "agg_netease_3391575975", title: "黄昏（纵然青丝如霜）（R&B版）", artist: "落日微醺" }), true);
check("同名不同歌手 + 不同 id —— 不是同一首", sameSongAs(
  { id: "agg_qq_111", title: "小幸运", artist: "田馥甄" },
  { id: "agg_netease_222", title: "小幸运", artist: "田馥甄的小迷妹" }), false);
check("同一首 QQ 歌的两份拷贝：判据本身认同一首 —— 所以调用方必须先按平台过滤，否则会把没可播版本的那首当重复删掉", sameSongAs(
  { id: "agg_qq_A", title: "难念的经", artist: "周华健" },
  { id: "agg_qq_A", title: "难念的经", artist: "周华健" }), true);
check("取不到 id 的条目（本地文件）退回标题+歌手", sameSongAs(
  { id: "local-1", title: "境随心变心自安", artist: "慕容小小" },
  { id: "local-2", title: "境随心变心自安", artist: "慕容小小" }), true);

// ---- 查"歌单里是不是已经有这首歌"：必须查整串，不是查已经处理过的那一段 ----
const 经典 = [
  { id: "agg_qq_A", title: "难念的经", artist: "周华健" }, // 本轮要处理的 QQ 条目
  { id: "agg_netease_7", title: "花心", artist: "周华健" },
  { id: "agg_netease_1809759264", title: "难念的经", artist: "周华健" }, // 可播版本排在**后面**
];
const 可播的 = 经典.filter((x) => songKeyOf(x).split(":")[0] !== "qq"); // 调用方的平台过滤
check("排在后面的可播版本也看得见（旧写法扫 keep 前缀，看不见 → 加了第二遍）",
  sameSongIn(可播的, 经典[0], 经典[0])?.id, "agg_netease_1809759264");
check("整串里没这首歌的另一个版本 —— 返回 undefined（该去搜候选，不是删）",
  sameSongIn(可播的, { id: "agg_qq_B", title: "沿途有你", artist: "周华健" }, undefined), undefined);
check("skip 自己：不会把自己当成「已有版本」而把唯一那条删掉",
  sameSongIn(经典, 经典[0], 经典[0])?.id, "agg_netease_1809759264");
check("没传 list 不炸", sameSongIn(undefined, 经典[0], undefined), undefined);

// ---- 末尾兜底去重：按身份键，保留第一次出现的那条 ----
const dd = dedupeById([
  { id: "agg_netease_1809759264", title: "难念的经", artist: "周华健" },
  { id: "agg_netease_7", title: "花心", artist: "周华健" },
  { id: "agg_netease_1809759264", title: "难念的经", artist: "周华健（Live）" },
  { id: "local-D:/a.mp3", title: "本地歌", artist: "某人" },
  { id: "local-D:/b.mp3", title: "本地歌", artist: "某人" },
]);
check("去重后条数", dd.list.length, 4);
check("保留第一次出现的那条（不是后到的）", dd.list[0].artist, "周华健");
check("重复品计数", dd.dropped.length, 1);
// 后面几条要能读第 0 条：判据被改坏时 dd.dropped 可能是空的，写成可选访问才能留下 FAIL 行而不是整个测试崩掉
check("重复品带着「留下的是哪一条」，报告才写得清", dd.dropped[0] ? `${dd.dropped[0].song.artist}|${dd.dropped[0].kept.artist}` : '没有重复品', "周华健（Live）|周华健");
check("无身份键的条目不参与去重（本地文件同名两条都留着）", dd.list.filter((s) => !songKeyOf(s)).length, 2);
check("空输入不炸", dedupeById(undefined).list.length, 0);

console.log(`song-match 判据：${pass} 项通过${fails.length ? `，${fails.length} 项失败：` : "，0 项失败"}`);
fails.forEach((f) => console.log(`  FAIL ${f}`));
if (fails.length) process.exit(1);
