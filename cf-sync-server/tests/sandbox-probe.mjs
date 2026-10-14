// 沙箱可行性探针（纯本地 Node，不碰 Cloudflare，几十秒能扫完整个音源目录）。
//
// 目的：只回答一个问题 —— runner 在启动阶段 `new Function(前缀 + 脚本 + 后缀)` 之后，
// 这个音源还能不能干活（注册 request 处理器、拿到直链）。
// 具体验证四件事：
//  1. 函数作用域里 `const globalThis = {...}` 遮蔽真实全局在 V8 里是否成立；
//  2. 用户脚本的 `const { EVENT_NAMES, on, send } = globalThis.lx` 是否拿到我们的沙箱；
//  3. on(request) 注册的处理器被 __request('musicUrl') 调用后，返回的是不是 http 直链；
//  4. 混淆稿能不能**编译过** —— 这是本机实测出来的硬约束：只要让打包器（esbuild）解析用户
//     脚本，它就会用 `Cannot assign to "x" because it is a constant` 拒绝整个 bundle，
//     而这类写法在 V8 里语法合法、只在执行到那一行才 TypeError。所以沙箱形态必须是
//     "脚本作为 Text 模块进 bundle + 启动期 new Function"，探针也就照这个形态跑。
//
// 用法：
//   node tests/sandbox-probe.mjs                                  # 默认那条源
//   node tests/sandbox-probe.mjs "../音源文件/xx.js" netease 3440441479
//   node tests/sandbox-probe.mjs --all                            # 扫整个音源目录（只编译，不发请求）

import { buildSandboxModule } from "../functions/lib/lx.js";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(here, "..", "..", "音源文件");
const DUMP = path.join(here, ".sandbox-probe.body.txt");

// 和 runner 入口里完全同一句：把生成的字符串当函数体编译，然后调用它拿沙箱导出。
function compile(scriptText) {
  const body = buildSandboxModule(scriptText);
  // eslint-disable-next-line no-new-func
  return { factory: new Function(body), body };
}

function probeOne(scriptText, { platform = "netease", rawID = "3440441479", dumpBody = false, request = true } = {}) {
  let mod;
  let factory;
  try {
    ({ factory } = compile(scriptText));
  } catch (e) {
    // 语法层：这一段是探针要盯的那个失败模式（V8 认为合法但打包器认为非法的写法，
    // 在 new Function 下是**能编译**的，只有执行到那行才 TypeError）。
    return { stage: "compile", error: String(e && e.message ? e.message : e) };
  }
  if (dumpBody) writeFileSync(DUMP, buildSandboxModule(scriptText), "utf8");
  try {
    mod = factory();
  } catch (e) {
    return { stage: "run", error: String(e && e.message ? e.message : e) };
  }
  const out = {
    stage: "ok",
    keys: Object.keys(mod),
    inited: mod.__registry && mod.__registry.inited,
    handlers: (mod.__registry && mod.__registry.handlers && mod.__registry.handlers.request || []).length,
    alerts: (mod.__registry && mod.__registry.alerts || []).slice(0, 3),
  };
  if (!request) return out;
  const lxKey = { qq: "tx", netease: "wy", kugou: "kg", kuwo: "kw", migu: "mg", bilibili: "bil" }[platform] || "wy";
  return mod
    .__request("musicUrl", {
      source: lxKey,
      info: { musicInfo: { id: rawID, songmid: rawID, mid: rawID, hash: rawID }, type: "320k", quality: "320k", startQuality: "320k" },
    })
    .then(
      (url) => ({ ...out, url: String(url) }),
      (e) => ({ ...out, urlError: String(e && e.message ? e.message : e) })
    );
}

if (process.argv.includes("--all")) {
  const files = readdirSync(SRC_DIR).filter((f) => /\.js$/i.test(f));
  let good = 0;
  console.log(`逐个 new Function 编译 + 执行（共 ${files.length} 个文件；不发网络请求）：`);
  for (const f of files) {
    const text = readFileSync(path.join(SRC_DIR, f), "utf8");
    const r = probeOne(text, { request: false });
    const sources = r.inited && r.inited.sources ? Object.keys(r.inited.sources).join(",") : "";
    const name = (f + "                              ").slice(0, 38);
    if (r.stage === "compile") console.log(`  ❌ ${name} ${text.length}B  语法层就过不了：${r.error.slice(0, 90)}`);
    else if (r.stage === "run") console.log(`  ⚠️ ${name} ${text.length}B  能编译，顶层执行抛错：${r.error.slice(0, 90)}`);
    else {
      good += 1;
      console.log(`  ✅ ${name} ${text.length}B  处理器 ${r.handlers}${sources ? ` · 平台 ${sources}` : ""}`);
    }
  }
  console.log(`\n沙箱可用的脚本：${good}/${files.length}`);
  process.exit(good === files.length ? 0 : 1);
}

const file = process.argv[2] || path.resolve(here, "..", "..", "音源文件/忆音音源_v1.js");
if (!existsSync(file)) {
  console.error(`找不到脚本文件：${file}`);
  process.exit(2);
}
const script = readFileSync(file, "utf8");
const platform = process.argv[3] || "netease";
const rawID = process.argv[4] || "3440441479";
const r = await probeOne(script, { platform, rawID, dumpBody: true });
console.log("生成的函数体已写到：", DUMP);
console.log("结果：", JSON.stringify(r, null, 2).slice(0, 2000));
