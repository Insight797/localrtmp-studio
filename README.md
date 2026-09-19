# LocalRTMP Studio

[![Release](https://img.shields.io/github/v/release/Insight797/localrtmp-studio?color=3fb950)](https://github.com/Insight797/localrtmp-studio/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/Insight797/localrtmp-studio/ci.yml?branch=main&label=CI)](https://github.com/Insight797/localrtmp-studio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2f81f7)](LICENSE)

一个跑在 macOS 上的本地 RTMP 推拉流服务器，带轻量桌面界面。把索尼 / 大疆等相机的 RTMP 流收进来，再喂给 OBS。

A local RTMP server for macOS with a lightweight desktop UI. It ingests RTMP from cameras (Sony, DJI, …) and hands the streams to OBS.

**中文 | [English](#english)**

---

## 中文

### 解决什么问题

相机（索尼 A7 系列 / Cinema Line、大疆 Pocket、RC Pro、GoPro 等）大多只支持 **RTMP 推流**，而 OBS 需要一个能持续拉流的地址。LocalRTMP Studio 就是中间这一层：本机起一个 RTMP 服务器，相机推进来，OBS 拉出去，顺带把录制、多设备通道管理、实时预览、码率监控都做好。

### 特性

- **零配置接入**：任何路径推进来就自动建立通道，不需要预先声明
- **三种拉流协议**：RTMP / HLS (LL-HLS) / WebRTC (WHEP)，界面上逐条一键复制
- **桌面 App**：Tauri 壳，打包后自带 `node`、`mediamtx`、`ffmpeg`，双击即用，不依赖终端
- **实时监看**：内置 WebRTC 低延迟预览，解码不出来时自动回退 HLS
- **一键转码**：H.265 源自动转成 `xxx_avc` 的 H.264 通道给 OBS（走 VideoToolbox 硬解）
- **录制**：fMP4 分片录制，按通道分目录，可在界面直接跳转 Finder
- **设备预设**：为每台相机存通道名、分辨率、码率建议和填法说明
- **运行监控**：实时码率、累计流量、拉流数、错帧计数、内核日志

### 架构

```
相机 (RTMP push) ──▶ MediaMTX ──▶ OBS / 播放器 / 录制文件
                        ▲
                        │ 生成配置 + HTTP API
                   Node 控制服务 (零依赖)
                        │
                   Tauri 桌面窗口 (WKWebView)
```

MediaMTX 负责所有流媒体工作，本项目负责配置生成、状态聚合和界面。控制服务不依赖任何 npm 运行时包。

### 快速开始

**直接下载（最省事）**：到 [Releases](https://github.com/Insight797/localrtmp-studio/releases/latest) 取 `LocalRTMP Studio-apple-silicon.dmg`。包内已自带 `node` / `mediamtx` / `ffmpeg`，拖进「应用程序」即可用（仅 Apple Silicon；首次打开右键 → 打开）。

**用打包好的 App（自己构建）**

```bash
brew install mediamtx        # 开发依赖，若只用打包版可跳过
npm ci
npm run app:build            # 产出 src-tauri/target/release/bundle/macos/LocalRTMP Studio.app
cp -R "src-tauri/target/release/bundle/macos/LocalRTMP Studio.app" /Applications/
```

**从源码跑**

```bash
brew install mediamtx rust
npm ci
npm run app                  # 桌面窗口
npm start                    # 或者只起后台服务，浏览器打开 http://127.0.0.1:8787
```

首次从局域网接收推流时，macOS 会弹出「mediamtx 是否接受传入连接」，点允许。

### 相机侧怎么填

界面左上角选对本机网卡（相机必须和这台 Mac 在同一网段），复制推流基址。

| 相机 | 填法 |
| --- | --- |
| 索尼（Creators App / FT1 / Cinema Line 网络直播） | 服务器：`rtmp://<Mac IP>:1935`，路径：`live/sony` |
| 大疆（RC Pro / Mimo 自定义 RTMP） | 直接粘贴完整地址 `rtmp://<Mac IP>:1935/live/dji` |
| 其它支持 RTMP 的设备 | 完整地址即可 |

端口 1935 是 RTMP 默认端口，所以 `rtmp://IP/live/x` 和 `rtmp://IP:1935/live/x` 等价；只有改过端口才必须带端口号。

### OBS 侧怎么拉

来源 → **媒体** → 取消勾选「本地文件」→ 输入 URL：

| 地址 | 延迟 | H.264 | H.265 | 音频 |
| --- | --- | --- | --- | --- |
| `rtmp://<Mac IP>:1935/live/sony` | 最低 | ✅ | ❌ | ✅ |
| `http://<Mac IP>:8888/live/sony/index.m3u8` | 2–4s | ✅ | ✅ | ✅ |
| `http://<Mac IP>:8889/live/sony/whep` | 低 | ✅ | ✅ | ❌ |

### H.265 推流在 OBS 里黑屏，不是 OBS 的问题

MediaMTX 在 **RTMP 出口**只能封装 H.264，遇到 H.265 轨会直接丢弃，日志里会看到：

```
WAR [RTMP] [conn ...] skipping track 1 (H265)
```

于是 OBS 收到的是「只有声音的流」→ 黑屏。三种解法：

1. **相机改 H.264**（最省心，局域网里 H.265 省的那点带宽没意义）
2. **OBS 改用 HLS 地址**，HLS/fMP4 能带 `hvc1`
3. **点界面上的「转 H.264」**，服务器起一路 ffmpeg，输出 `live/xxx_avc`，OBS 拉这个新通道

同理，WebRTC 出口不支持 AAC，所以 WHEP 拉流有画面没声音。

### 通道数量

没有数量上限，实测 6 路同时推 + 8 路同时拉正常。唯一的规则：**同一路径只能有一个发布者**，第二台用同一路径推流会把第一台顶掉。所以每台设备占一个独立路径。

真正的瓶颈依次是：相机侧 Wi-Fi 上行带宽 → OBS 同时解码能力 → 磁盘。8Mbps 录制约 3.6GB/小时/路。

### 端口与配置

| 端口 | 用途 | 绑定 |
| --- | --- | --- |
| 1935 | RTMP 推/拉 | 局域网（可切为本机only） |
| 8888 | HLS | 局域网 |
| 8889 | WebRTC (WHIP/WHEP) | 局域网 |
| 9997 | MediaMTX API | 仅 127.0.0.1 |
| 8787 | 控制台 | 仅 127.0.0.1 |

配置、预设、转码任务、日志都存在数据目录下，重启保留：

- 源码运行：`./data/`、`./recordings/`
- 打包 App：`~/Library/Application Support/studio.localrtmp.app/`

### 项目结构

```
server/            Node 控制服务（零运行时依赖）
  lib/store.js       设置与预设持久化、网卡枚举
  lib/mediamtx.js    内核配置生成、进程生命周期、状态 API
  lib/recordings.js  录制文件索引
  lib/transcode.js   H.264 转码通道管理
ui/                控制台界面（原生 HTML/CSS/JS，无构建步骤）
scripts/           prepare-bundle.js 复制 node/mediamtx/ffmpeg 到 vendor/
                   finalize-bundle.js 做 ad-hoc 签名并安装到 /Applications
                   make-icon.py       生成图标母图（改设计时才需要）
src-tauri/         Tauri 桌面壳（窗口加载本地控制台；打包态负责拉起 Node）
.github/workflows/ ci.yml 语法与 cargo check；release.yml 打 tag 自动出包
```

`vendor/`、`data/`、`recordings/`、`src-tauri/target/` 都已在 `.gitignore` 中。

### 自动构建与 Release

推一个版本号 tag 就会由 GitHub Actions 构建 Apple Silicon 的 `.app` / `.dmg` 并挂到 Release：

```bash
git tag v0.1.0 && git push origin v0.1.0
```

只出 arm64 包：GitHub 的 Intel macOS runner 已退役、排不到机器。需要 Intel 包就在 Intel Mac 上跑一次 `npm ci && npm run app:build`。

产物**没有做 Apple 开发者签名**（只有 ad-hoc 签名），所以别人首次打开会被 Gatekeeper 拦。两种放行方式：右键图标 → 打开；或

```bash
xattr -dr com.apple.quarantine "/Applications/LocalRTMP Studio.app"
```

改图标设计：`python3 scripts/make-icon.py && npx tauri icon src-tauri/app-icon.png`。

### 已知限制

- 仅 macOS 验证过（Linux 理论上可用，未测试）
- 转码要求本机或包内有 `ffmpeg`；打包脚本从本机 Homebrew 复制，因此**分发 .app 时请自行确认 ffmpeg 的 GPL 合规性**
- 录制格式为 fMP4 / MPEG-TS，不转码封装为单文件 MP4

---

## English

A local RTMP server for macOS with a lightweight desktop UI. Cameras (Sony A7 / Cinema Line, DJI Pocket, RC Pro, GoPro, …) mostly speak RTMP *push* only, while OBS needs a pull URL. This sits in between: ingest on 1935, hand the stream to OBS, and take care of recording, per-device channels, live preview and bitrate monitoring along the way.

### Features

- **Zero-config ingest** — any path becomes a channel automatically, no pre-declaration
- **Three egress protocols** — RTMP / LL-HLS / WebRTC (WHEP), each copyable per stream
- **Real desktop app** — Tauri shell; the bundled `.app` ships its own `node`, `mediamtx` and `ffmpeg`, no terminal needed
- **Live monitor** — low-latency WebRTC preview with automatic HLS fallback when the WebView can't decode
- **One-click transcode** — H.265 sources get repackaged into an `xxx_avc` H.264 channel for OBS (VideoToolbox decode)
- **Recording** — fragmented MP4, one folder per channel, reveal in Finder
- **Device presets** — store channel name, resolution, bitrate guidance per camera
- **Runtime metrics** — measured bitrate, transferred bytes, reader count, errored frames, kernel log

### Why OBS shows a black screen for H.265 cameras

MediaMTX can only mux H.264 into FLV/RTMP, so an H.265 video track is dropped on the RTMP egress:

```
WAR [RTMP] [conn ...] skipping track 1 (H265)
```

OBS then receives an audio-only stream. Use one of: switch the camera to H.264, pull the HLS URL instead, or hit **转 H.264** in the UI to spawn a transcode channel. WebRTC egress likewise drops AAC, so WHEP gives you video without audio.

### Channel limits

No limit on the number of channels — 6 concurrent publishers plus 8 readers were verified. The only rule: **one publisher per path**; a second device using the same path takes over. Real-world ceilings are Wi-Fi uplink, OBS decoding, then disk.

### Quick start

```bash
brew install mediamtx rust
npm ci
npm run app          # desktop window
npm run app:build    # build the .app bundle
```

### License

MIT — see [LICENSE](LICENSE).

### Credits

Streaming core: [MediaMTX](https://mediamtx.org) (MIT). Desktop shell: [Tauri](https://tauri.app).
