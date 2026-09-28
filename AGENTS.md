# 给其他 Agent 的使用说明（素材工坊）

本项目是本地优先的素材库。**其他 agent 可以直接读、也可以直接写**,下面是唯一需要知道的约定。

## 一、最快的用法:命令行(不需要 token)

工作目录 `<项目目录>\项目管理器`,用 `node --no-warnings tools/pm.ts <命令>`,全部支持 `--json`:

| 命令 | 作用 |
| --- | --- |
| `pm health` | 库路径与版本 |
| `pm projects --json` | 项目树与计数 |
| `pm search --q 关键词 --kind image --limit 20 --json` | 检索(返回 id、sha256、标题、类型、大小、模型、来源、可读路径、**描述 caption**、**标签 tags**、contentUrl/thumbUrl) |
| `pm get <id|sha256:哈希> --json` | 单件详情(含库内对象路径) |
| `pm read <id|sha256:哈希> --max-bytes 20000` | 文本/代码内容直出 |
| `pm tag <id> --add 词 [--add 词2] [--remove 词]` | **写**:增删标签 |
| `pm meta <id> --model 名 --origin ai\|real\|other --params "种子:123"` | **写**:改元数据 |
| `pm project <id> --to 项目名`(`--to ""` 移出) | **写**:归入项目 |
| `pm import <路径...> [--to 项目名] [--title 标题]` | **写**:把文件入库（按内容哈希幂等；内容已存在则跳过，不会产生重复） |
| `pm project --create 名字 [--parent 父名]` | **写**:新建项目 |
| `pm audit --limit 20` | 最近的写操作记录 |

**引用素材用 `sha256:哈希`** —— 改名、移动、换库内 id 都不失效;`id` 只在当前库稳定。

## 二、写操作的规矩(重要)

1. **写操作都会记进 `agent_audit` 表**(谁、什么时候、改了什么、改前改后),可用 `pm audit` 查;
2. 设环境变量 `PM_ACTOR=agent:你的名字` 让审计能区分是谁做的(默认 `agent:unknown`);
3. **不要直接改数据库、不要动 `objects\` 里的文件**(内容按哈希存放,手改会破坏校验);
4. 删除类动作(彻底删除素材/清空回收站)**必须先问人**,不要自行执行;
5. 大批量写之前先小批试一次(`--limit 3`),确认效果再全量。

## 二之二、密钥与凭证

- **不要读取、不要打印、不要写入任何密钥**:需要接口地址时只读 CSV 里的地址字段,密钥由程序运行时自行读取;
- 任何输出里的密钥一律用 `前缀…(长度 N)` 形式(打码要覆盖整串);
- 怀疑泄露 → 先请人轮换密钥,而不是只清理日志。

## 三、HTTP 方式(需要 token,只有读)

```powershell
$rt = Get-Content '<库目录>\runtime.json' | ConvertFrom-Json   # 里面有 port 与 token
Invoke-RestMethod "http://127.0.0.1:$($rt.port)/api/openapi.json"              # 接口清单(不需要 token)
Invoke-RestMethod "http://127.0.0.1:$($rt.port)/api/assets?q=深海&limit=10" -Headers @{ 'x-pm-token' = $rt.token }
Invoke-WebRequest "http://127.0.0.1:$($rt.port)/media/<id>" -Headers @{ 'x-pm-token' = $rt.token } -OutFile out.png  # 原始内容,支持 Range
```

- 写操作**目前没有 HTTP 接口**,走上面的命令行;
- 服务需要开着才能用 HTTP;命令行方式不依赖服务,但**写入时不要与人在界面上的批量操作同时进行**(库是单写者)。

## 四、能做什么 / 不能做什么

- ✅ 找素材(按关键词、类型、项目;描述与标签也参与检索)、看详情、读文本、取原始图/视频/音频、打标签、改模型/来源/生成参数、归入项目;
- ✅ 生成"画面描述/标签"用 `node --no-warnings tools/caption.ts`、`tools/tags.ts`(走 `<接口配置目录>` 的百炼接口,模型 `qwen3.8-omni-flash`;按内容跳过已完成的,可断点续跑);
- ✅ 入库新文件(`pm import`,原文件不动、内容相同自动去重)、新建项目(`pm project --create`);
- ❌ 不能删素材、不能清空回收站(需人工确认);
- ❌ 不能重命名库内的存储对象(那是内容寻址,不该动)。