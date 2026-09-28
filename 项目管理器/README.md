# 个人项目管理器 · M1 + 前端改版

本地优先的个人素材库：把散落的图片、视频、音频、文档、代码统一扫描或上传入库，用浏览器检索、预览、播放。
界面按参考原型（`<项目目录>\前端`，Next + Tailwind + shadcn）重做为**浅色设计**：侧栏（全部内容 / 回收站 / 我的项目）、七类模态筛选、4:3 卡片与列表视图。
方案与决策见 [开发建议](../文档/设计/开发建议.md)｜实测证据见 [M0](../文档/验证记录/验证记录.md)、[M1](../文档/验证记录/验证记录-M1.md)、[前端改版](../文档/验证记录/验证记录-前端改版.md)。

## 现在能做什么

**索引与检索（M0）**
- 扫描真实目录建立索引，默认忽略 `node_modules`、`.git`、`.venv`、`__pycache__`、`dist` 等依赖与构建产物
- 图片/视频缩略图（ffmpeg 抽帧，**按内容哈希缓存**，重建索引后依然命中）
- 中文检索：bigram + FTS5（单汉字走子串兜底）；按类型 / 项目 / **生成模型** 筛选与搜索
- 一键用系统默认程序打开、复制路径；视频支持拖动进度（HTTP Range）

**托管库（M1）**
- **复制导入**：把引用型素材复制进 `objects/<hh>/<hh>/<hash>.<ext>`，**原文件永不移动、不修改**
- **内容哈希去重**：同一内容只占一份空间（扫描、导入、上传三条通道都去重）
- **sidecar 双写**：元数据写在对象旁边，数据库只是索引；**删掉 index.db 也能凭 sidecar 重建**
- **自动重链**：库目录改名/搬家后一条命令修复；**回收站**软删除 + 恢复 + **清空**（原文件不动）
- **完整性核对**：索引/对象/sidecar/缩略图缓存四者一致性，可选重算哈希

**界面（本轮改版）**
- **侧栏**：全部内容、回收站、我的项目（带计数与标记色）、库信息与完整性核对入口
- **顶栏**：页面标题（项目简介在标题的悬停提示里）、搜索内容或模型、画廊 / 列表切换、添加素材
- **顶部信息**：只在**扫描或导入进行中**出现（显示进度条与当前文件）；库路径、计数、上次扫描在左下角与「库信息」对话框里
- **七类模态药丸**：全部类型 / 文本 / 代码 / 图片 / 视频 / 音乐 / 声音 / 综合（带真实计数，可再点取消）
- **卡片**：4:3 预览（图片与视频缩略图、视频带播放角标与时长、文本用 serif 摘要、代码用等宽摘要）、类型·模型徽章、日期、项目色点
- **列表视图**：行高约 56px，标题 + 摘要 + 徽章 + 项目 + 时长/日期
- **看图模式**：双击图片进入，滚轮以光标为中心自由缩放、拖拽平移、适应窗口/100%/旋转/翻页/快捷键
- **添加素材**：上传文件（可多选、可拖拽，原文件不被移动）或直接粘贴文本与代码；底部保留重新扫描 / 导入到库
- **项目**：新建（名称/简介/主要类型/标记色）、点选筛选、在详情栏里改所属项目
- **生成模型**：详情栏可直接标注并可被搜索

**看图模式（图片专用的全屏浮层）**
- 进入方式：在网格里**双击**图片，或点详情面板的「看图模式」/预览右下角「放大查看」
- 滚轮缩放，**以光标位置为中心**（放大后能直接看想看的地方，不会跑偏）；拖拽平移；双击在「适应窗口 / 100%」之间切换
- 顶栏：上一张 / 下一张、缩放百分比、适应窗口、100%、旋转 90°、外部打开、关闭
- 快捷键：`Esc` 关闭 · `←/→` 翻页 · `+/-` 缩放 · `0` 适应窗口 · `1` 实际大小 · `R` 旋转
- 显示的是**原图**而不是缩略图，底部标出真实像素尺寸
- 只在图片上生效：双击视频/音频不会打开；回收站里的图片同样能看、能缩放

## 启动

```powershell
# 方式一：双击
start-server.bat

# 方式二：手动
npm run web:build      # 构建前端（改动前端后需要）
npm run serve          # 启动本地服务，默认 http://127.0.0.1:8756
```

端口被占用时自动往后找可用端口，实际端口与本次会话 token 写在 `<库目录>\runtime.json`。
**服务每次启动都会换新 token**；如果你留着一个旧标签页，页面会在收到 401 时**自动刷新一次**取回当前凭据，不需要手动重开。
前端开发模式（热更新，`/api` 由 Vite 代理并代填 token）：`npm run web:dev`（需先启动服务；注意 Vite 代理在启动时读取 `runtime.json`，**换过 token 后要重启 Vite**）。

## 命令行

```powershell
# M0
node --no-warnings core/cli.ts scan [目录] [--force] [--limit N]
node --no-warnings core/cli.ts stats
node --no-warnings core/cli.ts search "<剧集>" --kind image --limit 20
node --no-warnings tools/walk-check.ts "D:\某个目录"        # 只读预演：看扫描器会索引什么

# M1
node --no-warnings core/cli.ts import [--root <路径>] [--limit N] [--force]
node --no-warnings core/cli.ts verify [--hash]              # 一致性核对（--hash 会重算 sha256）
node --no-warnings core/cli.ts relink                       # 库改名/搬家后重链
node --no-warnings core/cli.ts rebuild [--wipe-managed]     # 从 sidecar 重建索引
node --no-warnings core/cli.ts trash <id> | restore <id>    # 回收站
node --no-warnings core/cli.ts manifest                     # 生成校验和清单
node --no-warnings core/cli.ts reindex                      # 重建全文索引 + 回填文本摘要
```

## 目录结构

```
core/      纯 Node：扫描、哈希、元数据、缩略图、索引、查询、导入、维护（无 UI、无 HTTP）
server/    本地 HTTP 服务：REST + 媒体流（Range）+ 文本预览 + 缩略图 + 扫描/导入作业
web/       浏览器前端（React + Vite）
tools/     诊断脚本
dist/web/  前端构建产物（可重建）

<库目录>\                   数据（≠ 代码目录）
  library.json               库标识
  config.json                来源根目录、忽略规则、端口、ffmpeg 路径
  index.db                   索引（可删除、可重建）
  objects\ab\cd\<hash>.<ext> 内容寻址的托管对象
  objects\ab\cd\<hash>.json  sidecar：元数据与来源
  derived\thumbs\<hash>.webp 缩略图缓存（可再生）
  trash\                     回收站
  manifests\                 校验和清单
```

## 安全边界（本地服务）

- 只绑定 `127.0.0.1`，**不是** `0.0.0.0`
- 每次启动生成随机 token；页面由服务端注入，媒体与缩略图用 `?token=`（`<img>`/`<video>` 无法带自定义头）
- 校验 `Host` 必须是本机回环地址（防 DNS rebinding），跨源请求一律拒绝，不发 CORS 头
- 诚实说明：token 防的是**网页来源**的攻击；本机其它进程本来就能直接读磁盘上的库

## 已知限制

- SQLite 为 `node:sqlite` 内置的 **3.51.2**（低于 WAL-reset 修复版 3.51.3）。单进程单写者不触发；**引入多进程写入前必须先升级**。
- **库目录不要放在 OneDrive / 坚果云 / 网络盘**（WAL 需要共享内存，会损坏数据库）。
- 搬家检测目前只在**同盘改名**上验证过；跨盘/换机器未实测。
- 备份只有校验和清单，**尚未做过真实恢复演练**。
- **模态计数与筛选是客户端按已加载的 ≤1000 件算的**：素材超过 1000 件时计数会偏小，分页 + 服务端聚合属于 M4。
- 音频没有真实波形（有意不画假波形，等 M2 用 ffmpeg 预算 peaks）；「综合」当前映射到未归类素材，真正的多模态合集属 M3。
- 窄屏（<900px）侧栏直接隐藏，没有替代导航；触摸屏双指缩放未实现。
- 上传只验证过 0.8MB 文件；**大文件（>2GB）、断线中断、并发上传未测**（服务端上限 8GB，流式落盘）。
- 项目删除只有接口，没有界面入口。

## 下一步（M2）

统一预览器：音频波形（预计算 peaks）、PDF/Office、代码高亮、视频悬停预览、missing 状态呈现。
详见 [开发建议](../文档/设计/开发建议.md) §6 与 [验证记录-M1](../文档/验证记录/验证记录-M1.md) 的"下一步建议"。
## 给机器与 AI 使用

界面是给人点的；要让脚本或 AI 直接用，走这两条：

- **接口清单（自描述）**：`GET http://127.0.0.1:<端口>/api/openapi.json` —— 不需要 token，列出全部接口、参数、返回，以及素材对象每个字段的含义。
- **命令行**：`npm run pm -- <命令>`（或 `node --no-warnings tools/pm.ts <命令>`），全部支持 `--json`：

```
npm run pm -- health                           # 库路径与版本
npm run pm -- projects --json                  # 项目树与计数
npm run pm -- search --kind image --limit 10 --json
npm run pm -- search --q 逆光 --project <角色E> --json
npm run pm -- get sha256:0151a93d… --json      # 详情 + contentUrl/thumbUrl
npm run pm -- read sha256:0151a93d… --max-bytes 20000   # 文本/代码直出
```

- **取内容**：`/thumb/:id`（缩略图）、`/media/:id`（原始字节，支持 Range，可直接喂多模态模型）；两者都需要请求头 `x-pm-token`（token 见库目录 `runtime.json`）。
- **引用素材建议用 `sha256:哈希`**：改名、移动、换库内 id 都不失效；库内 `id` 只在当前库稳定。
### 生成一句话描述（caption，供按意思检索）

复用 ai-editor 的 MiMo 配置（地址 `AI_EDITOR_VISION_BASE` 或 `capabilities.yaml`，密钥 `AI_EDITOR_VISION_KEY`/`AI_EDITOR_MIMO_KEY` 或 `ai-editor\.mimo_key`，模型默认 `mimo-v2.6-flash`）：

```
node --no-warnings tools/caption.ts --dry-run --limit 3        # 只看会处理谁，不花钱、不写库
node --no-warnings tools/caption.ts --id 3                     # 单件
node --no-warnings tools/caption.ts --kind image --limit 50     # 批量（按内容跳过已生成的，可断点续跑）
node --no-warnings tools/caption.ts --kind image --force --limit 50   # 重跑已有描述
```

描述写进 `asset.caption`（含 `caption_model` / `captioned_at`）并**并入全文索引**，因此 `pm search --q 海边的逆光` 能按画面内容命中。**不建向量库**：以后要语义检索，把这一列换成向量列即可（派生数据，可清空重跑）。

内建了你实测踩过的坑：显式 `thinking={type:disabled}`（2.6 默认开思考会吃光 token 导致 content 为空）、解析前先抠第一个 `{` 到最后一个 `}`、`reasoning_content` 不当正文。
### 视频分析用哪家接口（用户指定）

- **所有分析（图片、视频、标签）都走** `<接口配置目录>\qwen百炼\*.csv` 里的百炼(阿里云) OpenAI 兼容接口：地址取 `openAiCompatible`、密钥取 `apiKey`（入口函数 `loadAnalysisConfig`；CSV 不可用时才回落 MiMo）；
- **默认模型 `qwen3.8-omni-flash`** —— 实测这把 key 只放行部分模型（`qwen-vl-max`、`qwen3-vl-plus`、`qwen3.5-omni-plus`、`qwen3.8-max-0902` 均返回 `403 Access denied by API-Key restrictions`，而 `qwen3.8-omni-flash` 正常）；
- 需要临时换接口/模型时用环境变量覆盖：`PM_VIDEO_BASE` / `PM_VIDEO_KEY` / `PM_VIDEO_MODEL`（优先级最高）；
- 回落用的 MiMo 配置（仅在 CSV 缺失时）：`AI_EDITOR_VISION_BASE` / `.mimo_key` / `mimo-v2.6-flash`；
- 那个 CSV 在仓库之外、不会被 git 跟踪，代码里也**不写死密钥**。
