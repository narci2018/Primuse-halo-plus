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

/**
 * 一条歌的**身份键**：`platform:rawID`。
 * 线上形状（`{id:'agg_netease_123', filePath:'/aggregated/netease/123.mp3'}`）与本机形状
 * （`{platform:'netease', rawID:'123'}`）都认，取不到就返回空串（本地文件条目就是这种）。
 */
export const songKeyOf = (s) => {
  const m = /^agg_([a-z0-9]+)_(.+)$/i.exec(String((s && s.id) || ''));
  if (m) return `${m[1].toLowerCase()}:${m[2]}`;
  const p = String((s && s.platform) || '').toLowerCase();
  return p && s.rawID ? `${p}:${String(s.rawID)}` : '';
};

/** 同一个**条目**（同一个 `platform:rawID`）—— 跨平台永远不相等，用它判"这一首已经有了"。 */
export const sameKeyAs = (a, b) => {
  const ka = songKeyOf(a);
  const kb = songKeyOf(b);
  return Boolean(ka && kb) && ka === kb;
};

/** 同名同歌手（规范化后的标题整等 + 人名段整等）—— 跨平台也能相等，用它判"这首歌已经有了另一个版本"。 */
export const sameTitleAndArtistAs = (a, b) =>
  norm(a && a.title) === norm(b && b.title) && artistHit(a && a.artist, b && b.artist);

/**
 * 是不是同一首歌：**身份键相同，或"同名同歌手"**。
 * 两条都得要，各挡一类现网事故：
 *   - 只比标题字符串漏掉了 id —— 用户自己早就加过 `黄昏（纵然青丝如霜）（R&B版）`，
 *     它和 QQ 那条 `黄昏（纵然青丝如霜）` 换出来的 netease id **是同一个** `netease:3391575975`，
 *     括号里多了三个字就认不出来，同一个 id 在同一个歌单里出现两遍。
 *   - 只比 id 漏掉了跨平台的同名同歌手 —— QQ:123 与 netease:456 是同一首歌，id 永远不同，
 *     这种该直接删 QQ 那条，不必再搜一遍。
 * 取不到身份键的条目（本地文件）只走标题+歌手那条路。
 */
export const sameSongAs = (a, b) => sameKeyAs(a, b) || sameTitleAndArtistAs(a, b);

/**
 * 在 `list` 里找"已经有同一首歌的另一个版本"，返回那条或 `undefined`。
 * `list` 由调用方**先过滤好**（换源那步只该看"非 FROM 平台"的条目，否则 QQ 上自己的另一份拷贝
 * 会被当成"已经有可播版本"而直接删掉 —— 那是丢歌，不是去重）。
 * `skip` 是本轮正要处理的那一条对象，不能自己跟自己重。
 *
 * 调用方必须把**整张歌单**传进来，不是"已经处理过的那一段"。旧写法扫的是 `keep` 前缀，
 * 于是可播版本排在 QQ 那条**后面**就看不见 —— `难念的经`、`沿途有你` 各被加了第二遍。
 */
export const sameSongIn = (list, song, skip) =>
  (list || []).find((x) => x !== song && x !== skip && sameSongAs(x, song));

/**
 * 按身份键去重，**保留第一次出现的那条**，返回 `{ list, dropped }`。
 * dropped 里带上 `kept`，报告才能写清"删掉的是重复品，留下的是哪一条"。
 */
export const dedupeById = (songs) => {
  const seen = new Map();
  const list = [];
  const dropped = [];
  (songs || []).forEach((s) => {
    const k = songKeyOf(s);
    if (!k) { list.push(s); return; } // 本地文件条目没有身份键，不参与去重
    if (seen.has(k)) { dropped.push({ song: s, kept: seen.get(k) }); return; }
    seen.set(k, s);
    list.push(s);
  });
  return { list, dropped };
};

