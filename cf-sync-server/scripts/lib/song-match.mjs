/**
 * 歌曲身份判据：把「同一首歌、同一位演唱者」这句话落成可以测的代码。
 *
 * 只给 `scripts/repoint-dead-songs.mjs`（批量换源）用，服务端接口不依赖它 ——
 * 但它是**纯函数**，所以单独放一个文件，CI 能直接跑 `tests/song-match.test.mjs` 钉住它。
 * 为什么要钉：这一轮的现网教训是判据松一格就会换错歌 —— `小幸运` 的那条候选歌手写的是
 * **`田馥甄的小迷妹`**（一个翻唱者的艺名），旧写法「整串互相包含」把它当成田馥甄收了。
 * 这种错在报告里看着完全合理（歌名对、歌手串里含原唱名），只有断言能拦住。
 */

/** 规范化：转小写，去掉空白、全角空格、中英文标点，以及横杠/乘号/字母 x 这类装饰符。 */
export const norm = (x) =>
  String(x || '')
    .toLowerCase()
    .replace(/[\s　·．.,，、;；:：\/\-—_｜|()（）\[\]【】'"“”‘’'’!！?？~～×x]/g, '');

/** 去掉标题里的版本说明（括号段），用于"退让一级"的匹配：我的梦 (Live) ≈ 我的梦。 */
export const baseTitle = (x) => norm(String(x || '').replace(/[（(\[【].{0,24}[)）\]】]/g, ''));

/**
 * 歌手名切成"人名段"。
 * 括号里的本名摊平成一段（`等什么君(邓寓君)` → 等什么君 / 邓寓君），`cover:` 署名同理，
 * 合作曲的分隔符（`,` `、` `/` `&` `feat.` `with`）也切开。
 */
export const artistSegments = (x) =>
  String(x || '')
    .replace(/[\(（【\[]/g, ',')
    .replace(/[\)）】\]]/g, ',')
    .replace(/\bcover\b/gi, ',')
    .split(/[,，、:：;/／&｜|]+|\s+feat\.?\s+|\s+ft\.?\s+|\s+with\s+/i)
    .map((p) => norm(p))
    .filter(Boolean);

/**
 * 同一位演唱者：**任一人名段整段相等**才算。
 * 刻意不做子串 —— `田馥甄的小迷妹`、`谢安琪Kay` 这种"包含原唱名"的艺名必须判 false；
 * 合作署名（`张靓颖, 卢昶宇, 王艺陶, 李秉成`）里带原唱名，切段后仍判 true。
 * 也刻意不做中英名互认（`A-Lin` ≠ `黄丽玲`）：那是艺人知识库的活，猜错了就是换了一首别人的歌，
 * 换不到就留在原地并写进报告，让人来判。
 */
export const artistHit = (a, b) => {
  const A = artistSegments(a);
  const B = artistSegments(b);
  return A.some((x) => B.includes(x));
};

/** 报告里说清楚"认的是哪一段"，否则看不出错换。 */
export const artistMatchLabel = (a, b) => {
  const A = artistSegments(a);
  const B = artistSegments(b);
  return A.find((x) => B.includes(x)) || `${a}|${b}`;
};

/** 标题：先要完全相等，再退让到"去掉括号里的版本说明后相等"。 */
export const titleTier = (candidateTitle, wantedTitle) => {
  if (norm(candidateTitle) === norm(wantedTitle)) return 'exact';
  if (norm(candidateTitle) !== norm(wantedTitle) && baseTitle(candidateTitle) === baseTitle(wantedTitle)) return 'relaxed';
  return '';
};
