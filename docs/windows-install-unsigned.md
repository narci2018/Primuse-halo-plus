# 未签名 Windows 包的安装与功能边界

适用于 CI 产物 `HALO-Music-Setup-<版本>-x64.exe` 与 `HALO-Music-Portable-<版本>-x64.exe`（外加 `latest.yml`），来自 `.github/workflows/build-win.yml`，与 iOS 的 `.ipa`、macOS 的 `.dmg/.zip` 挂在**同一条版本 Release** 上。

## 这个包是怎么做出来的

壳是仓库里现成的 `electron/main.cjs` + `electron/preload.cjs`，播放器是现成的网页端（`index.html` / `major.js` / `styles.css` / `admin/`），打包器是 `package.json` 的 `build` 段 —— 没有新的 Windows 原生代码。本机（Windows 11，build 26200）实测过的部分：

- `electron-builder` 26.15.3 + `electron` 37.10.3，`--win nsis portable` 一次跑通，产物各约 88–89 MB。
- 版本资源被正确盖成发版号：`FileVersion` / `ProductVersion` = `1.9.8`（靠 CI 的 `--config.extraMetadata.version=<tag>`，不是改 `package.json`）。
- `Get-AuthenticodeSignature` = **NotSigned**，两个 exe 都是。没有证书（D3），这是预期而不是缺陷。
- 打包产物 `app.asar`（2.4 MB，313 个条目）里确认含有 `\electron\main.cjs`、`\electron\preload.cjs`、`\index.html`、`\major.js`、`\styles.css`、`\admin\index.html`，以及运行时依赖 `electron-updater`。
- `release\win-unpacked\HALO Music.exe` 启动成功：进程组存活，窗口标题变成 **"Halo音乐"** —— 标题来自 `https://halo-music.pages.dev` 的页面，说明壳确实加载了线上 SPA，不是白屏。

## 两个包怎么选

| | `HALO-Music-Setup-<版本>-x64.exe` | `HALO-Music-Portable-<版本>-x64.exe` |
|---|---|---|
| 安装 | NSIS 向导，装进 Program Files | 无安装，双击运行 |
| 权限 | **需要管理员授权**（`nsis.perMachine: true`，会弹 UAC） | 不需要 |
| 卸载 | 设置 → 应用 → HALO Music | 删文件即可 |
| 快捷方式 | 安装向导里有"创建桌面快捷方式 / 开机自启动"两个勾选项 | 无 |
| 适合 | 长期自用、给别人一台装好的机器 | **发给别人测试首选**，单个 exe 拷走就行 |

## 首次运行放行

没有代码签名，Windows 11 的 SmartScreen 会拦一次：

1. 双击 exe → 出现蓝色"已保护你的电脑 / Windows 已阻止启动此未知应用"。
2. 点**「更多信息」**，然后点**「仍要运行」**。没有证书时这是唯一路径，"更多信息"这个折叠按钮不会被省掉。
3. 若被 Microsoft Defender 的"未知发布者"提示吓到：这确实说明发布者未知，包里也没有夹带别的东西 —— 产物由公开的 Actions 流水线（`.github/workflows/build-win.yml`）从本仓库源码直接打出，每个 job 的日志和步骤都能匿名查看。

彻底绕过 SmartScreen 只有两条路：买代码签名证书，或者在你自己的机器上关闭应用控制（不建议，且 Win11 默认已不允许长期关闭）。

## 这个形态下已知的工作方式

- **访问的地址**：默认 `https://halo-music.pages.dev`，可以用命令行 `--url=https://你的地址` 或环境变量 `HALO_MUSIC_URL` 覆盖（`electron/main.cjs:5-13`）；把 URL 置空才会退回加载包体内的 `index.html`。
- **音源**：完全由你访问的那个网页实例决定。这个包**还没有**接 iPhone 上那条自建服务器（道理鱼）—— 那是 M2 的内容，见 `docs/cross-platform-plan.md` §13/§15。
- **自动更新**：包内 `app-update.yml` 现在指向 `narci2018/Primuse-halo-plus`，`latest.yml` 随每次发版一起挂到 Release，所以更新只会来自这个仓库。修复前它指向的是上游 `zhoujungis/halo_music`，本机实测到的是 `Checking for update` → `404 Cannot find latest.yml .../v2.0.0/latest.yml`，也就是说那时候发出去的 exe 会去别人的仓库找更新。
- **更新下载是自动的**：`electron/main.cjs:48` 设了 `autoDownload = true`。未签名 + 自动下载 = 装上新版时可能再撞一次 SmartScreen，见下面"尚未证实"。

## 尚未证实的部分（需要你在真机上确认）

1. **Setup 安装向导的完整流程**：我没有在这台机器上真的安装（会写 Program Files 并弹 UAC）。`perMachine: true` 需要管理员账号；"创建桌面快捷方式 / 开机自启动"两个勾选项来自 `build/installer.nsh` 的 `customPageAfterChangeDir` 宏 —— 官方 NSIS 模板确实会调用它（`assistedInstaller.nsh:42-43`），但界面是否如预期出现，只有跑一次安装才知道。
2. **登录态存在哪里**：Electron 默认把 cookie/缓存放在 `%APPDATA%\HALO Music`，理论上是"装一次登一次、重启还在"。没实测。
3. **未签名包被自动更新装上时的行为**：`autoDownload=true` 会让它静默下载 89 MB 的未签名 Setup 并在退出时执行，SmartScreen 会不会在这一步拦死 —— 未知。若你遇到"更新失败/装不上"，先手动下载 Release 里的 Setup 覆盖安装。
4. **Release 大文件的匿名下载**：`api.github.com` 能匿名读到 Release 与三个 asset 的元数据（已验证 HTTP 200），但这台机器的 `curl` 拿 `github.com/.../releases/download/...` 返回 000 —— 本机 shell 不走系统代理（装了 ProxyBridge / sing-box）导致的网络问题，不是权限问题：同一个包里的应用自己查更新是成功的，而它走的是系统代理。浏览器下载正常即可。
