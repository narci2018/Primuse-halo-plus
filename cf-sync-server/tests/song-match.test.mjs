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
//   - titleTier 去掉 relaxed 档 → 「我的梦 ↔ 我的梦 (Live)」FAIL。

import { norm, baseTitle, artistSegments, artistHit, artistMatchLabel, titleTier } from "../scripts/lib/song-match.mjs";

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

console.log(`song-match 判据：${pass} 项通过${fails.length ? `，${fails.length} 项失败：` : "，0 项失败"}`);
fails.forEach((f) => console.log(`  FAIL ${f}`));
if (fails.length) process.exit(1);
