# Moltworker 架构文档

> Moltworker 是一个运行在 Cloudflare Workers 上的个人 AI 助手沙箱平台，通过容器化技术将 [OpenClaw](https://github.com/nichochar/openclaw) 网关部署到 Cloudflare 边缘网络，提供 Web 聊天、设备配对管理、多渠道消息集成和浏览器自动化能力。

## 目录

- [技术栈](#技术栈)
- [系统架构](#系统架构)
- [目录结构](#目录结构)
- [核心业务流程](#核心业务流程)
- [关键模块详解](#关键模块详解)
- [API 接口清单](#api-接口清单)
- [Cloudflare 服务集成](#cloudflare-服务集成)
- [配置和环境变量](#配置和环境变量)
- [测试体系](#测试体系)
- [CI/CD 和部署](#cicd-和部署)

---

## 技术栈

| 层级 | 技术 |
|------|------|
| **运行时** | Cloudflare Workers + Sandbox Containers |
| **Web 框架** | [Hono](https://hono.dev/) v4 |
| **前端** | React 19 (SPA, Vite 构建) |
| **认证** | Cloudflare Access (JWT) + 网关令牌 + 设备配对 |
| **存储** | Cloudflare R2 (通过 rclone 同步) |
| **浏览器自动化** | Cloudflare Browser Rendering + Puppeteer |
| **AI 提供商** | Anthropic / OpenAI / Cloudflare AI Gateway |
| **消息渠道** | Telegram / Discord / Slack |
| **容器内核心** | OpenClaw 网关 (Node.js 22) |
| **构建工具** | Vite 6, TypeScript 5.9, Wrangler 4 |
| **代码质量** | oxlint, oxfmt, TypeScript strict mode |
| **测试** | Vitest (单元) + cctr/plwr/Playwright (E2E) |
| **IaC** | Terraform (Cloudflare provider) |

---

## 系统架构

```
                          ┌──────────────────┐
                          │   用户 / 设备     │
                          └────────┬─────────┘
                                   │ HTTPS / WSS
                                   ▼
                     ┌─────────────────────────────┐
                     │    Cloudflare Access (可选)   │
                     │  JWT 验证 · Zero Trust 策略   │
                     └─────────────┬───────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│                  Cloudflare Worker (moltbot-sandbox)              │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                    Hono 应用层                              │  │
│  │                                                            │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────┐  ┌──────────────┐  │  │
│  │  │ 公开路由  │  │ API 路由 │  │ CDP  │  │  Admin UI    │  │  │
│  │  │ /status  │  │ /api/*   │  │ /cdp │  │  /_admin/*   │  │  │
│  │  └──────────┘  └──────────┘  └──────┘  └──────────────┘  │  │
│  │                       │                                    │  │
│  │              ┌────────▼────────┐                           │  │
│  │              │  认证中间件层    │                           │  │
│  │              │ CF Access + JWT │                           │  │
│  │              └────────┬────────┘                           │  │
│  └───────────────────────┼────────────────────────────────────┘  │
│                          │                                       │
│  ┌───────────────────────▼────────────────────────────────────┐  │
│  │              Sandbox Container (Docker)                     │  │
│  │                                                            │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │           OpenClaw Gateway (:18789)                   │  │  │
│  │  │                                                      │  │  │
│  │  │  HTTP ◄──── containerFetch() ────► Worker            │  │  │
│  │  │  WS   ◄──── wsConnect() ─────────► Worker            │  │  │
│  │  │                                                      │  │  │
│  │  │  ┌────────────┐  ┌──────────┐  ┌──────────────────┐ │  │  │
│  │  │  │ AI 对话引擎 │  │ 设备配对  │  │ 消息渠道桥接     │ │  │  │
│  │  │  │ Anthropic  │  │ 管理     │  │ TG/Discord/Slack │ │  │  │
│  │  │  │ OpenAI     │  │         │  │                  │ │  │  │
│  │  │  └────────────┘  └──────────┘  └──────────────────┘ │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  │                                                            │  │
│  │  ┌────────────────┐     ┌──────────────────────────────┐  │  │
│  │  │  rclone 同步    │ ──► │  Cloudflare R2 (moltbot-data) │  │  │
│  │  │  每 30s 检查    │     │  配置 / 工作区 / 技能         │  │  │
│  │  └────────────────┘     └──────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Cloudflare Browser Rendering                  │  │
│  │              Puppeteer ◄── /cdp 端点 ──► CDP 客户端       │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 目录结构

```
moltworker/
├── src/
│   ├── index.ts              # 主入口：Hono 应用、中间件链、WebSocket 代理
│   ├── types.ts              # TypeScript 类型定义（MoltbotEnv, AppEnv, AccessUser）
│   ├── config.ts             # 常量配置（端口 18789、启动超时 180s）
│   ├── assets.d.ts           # HTML/PNG 模块声明
│   ├── env.d.ts              # Cloudflare 环境类型声明
│   ├── test-utils.ts         # 测试辅助工具
│   │
│   ├── auth/                 # 认证模块
│   │   ├── index.ts          #   导出聚合
│   │   ├── jwt.ts            #   Cloudflare Access JWT 验证（jose 库）
│   │   ├── jwt.test.ts       #   JWT 验证单元测试
│   │   ├── middleware.ts     #   Hono 认证中间件工厂
│   │   └── middleware.test.ts#   中间件单元测试
│   │
│   ├── gateway/              # 网关生命周期管理
│   │   ├── index.ts          #   导出聚合
│   │   ├── process.ts        #   进程查找、启动、健康检查
│   │   ├── process.test.ts   #   进程管理单元测试
│   │   ├── env.ts            #   环境变量映射（Worker → 容器）
│   │   ├── env.test.ts       #   环境变量映射测试
│   │   ├── r2.ts             #   rclone 配置写入
│   │   ├── r2.test.ts        #   R2 配置测试
│   │   ├── sync.ts           #   容器 → R2 数据同步
│   │   ├── sync.test.ts      #   同步逻辑测试
│   │   └── utils.ts          #   进程等待工具函数
│   │
│   ├── routes/               # 路由定义
│   │   ├── index.ts          #   导出聚合
│   │   ├── public.ts         #   公开路由（健康检查、状态、静态资源）
│   │   ├── api.ts            #   Admin API（设备管理、存储、网关重启）
│   │   ├── admin-ui.ts       #   Admin SPA 入口
│   │   ├── cdp.ts            #   Chrome DevTools Protocol 代理（1919 行）
│   │   └── debug.ts          #   调试路由（进程、日志、CLI、环境）
│   │
│   ├── client/               # React Admin UI（Vite SPA）
│   │   ├── main.tsx          #   React 入口
│   │   ├── App.tsx           #   根组件 + 路由
│   │   ├── App.css           #   全局样式
│   │   ├── index.css         #   基础样式
│   │   ├── api.ts            #   API 客户端（fetch 封装）
│   │   └── pages/
│   │       ├── AdminPage.tsx  #   设备管理 + 存储状态 + 网关控制
│   │       └── AdminPage.css  #   Admin 页面样式
│   │
│   ├── utils/
│   │   └── logging.ts        #   URL 敏感参数脱敏
│   │
│   └── assets/
│       ├── loading.html      #   网关启动中加载页面
│       └── config-error.html #   配置错误提示页面
│
├── start-openclaw.sh         # 容器启动脚本（329 行）
├── Dockerfile                # 容器镜像定义
├── wrangler.jsonc            # Cloudflare Worker 部署配置
├── package.json              # 依赖和脚本命令
├── tsconfig.json             # TypeScript 配置
├── vite.config.ts            # Vite 构建配置（base: /_admin/）
├── vitest.config.ts          # Vitest 测试配置
│
├── test/
│   └── e2e/                  # 端到端测试
│       ├── .dev.vars.example #   E2E 环境变量模板
│       ├── pairing_and_conversation.txt  # 主测试场景
│       ├── _setup.txt        #   测试前置（启动服务器+浏览器+录屏）
│       ├── _teardown.txt     #   测试后置（清理资源）
│       └── fixture/
│           └── server/       #   Terraform + 部署脚本
│               ├── main.tf   #     基础设施定义
│               ├── outputs.tf#     Terraform 输出
│               ├── start     #     启动基础设施
│               ├── stop      #     销毁基础设施
│               ├── deploy    #     Wrangler 部署
│               ├── delete-worker   # Worker 删除
│               ├── create-access-app # Access 应用创建
│               └── terraform-apply   # Terraform 执行
│
└── .github/
    └── workflows/
        └── test.yml          # CI/CD：lint + typecheck + unit + E2E
```

---

## 核心业务流程

### 1. 请求处理全流程

```
HTTP/WS 请求到达
       │
       ▼
  ① 请求日志记录 (method, path, user-agent)
       │
       ▼
  ② 公开路由匹配？──── 是 ──→ 直接返回（/sandbox-health, /api/status, 静态资源）
       │ 否
       ▼
  ③ CDP 路由匹配？──── 是 ──→ 验证 ?secret= 参数 → CDP/Puppeteer 处理
       │ 否
       ▼
  ④ 沙箱容器初始化 (Durable Object)
       │
       ▼
  ⑤ 环境变量验证（DEV/E2E 模式跳过）
       │ 缺少必需变量 → 503 错误页面
       ▼
  ⑥ Cloudflare Access JWT 验证
       │ 无效/缺失 → 401 或重定向到登录
       ▼
  ⑦ 已认证路由匹配？
       │
       ├─ /api/*      → Admin API 处理
       ├─ /_admin/*   → SPA 入口 (index.html)
       ├─ /debug/*    → 调试路由（需 DEBUG_ROUTES=true）
       │
       └─ 其他所有路由 → ⑧ 代理到 OpenClaw 网关
                              │
                              ├─ 网关未就绪 + HTML 请求 → 返回加载页面，后台启动网关
                              ├─ WebSocket → 创建双向代理，拦截错误消息
                              └─ HTTP → containerFetch() 直接代理
```

### 2. 容器生命周期管理

```
ensureMoltbotGateway(sandbox, env)
       │
       ▼
  ① ensureRcloneConfig()
       │  写入 /root/.config/rclone/rclone.conf
       │  幂等：检查 /tmp/.rclone-configured 标志
       │
       ▼
  ② findExistingMoltbotProcess()
       │  匹配：start-openclaw.sh | openclaw gateway
       │  排除：openclaw devices | openclaw --version
       │
       ├─ 找到进程 → waitForPort(:18789, timeout=180s)
       │     │
       │     ├─ 端口可达 → 返回现有进程 ✓
       │     └─ 超时 → kill 进程，继续到 ③
       │
       └─ 未找到 → 继续到 ③
       │
       ▼
  ③ sandbox.startProcess('/usr/local/bin/start-openclaw.sh')
       │  传入 buildEnvVars(env) 构建的环境变量
       │
       ▼
  ④ waitForPort(:18789, timeout=180s)
       │
       ├─ 成功 → 返回新进程 ✓
       └─ 失败 → 抛出错误（包含 stderr 日志）
```

**容器启动脚本 (`start-openclaw.sh`) 内部流程：**

```
start-openclaw.sh
       │
       ▼
  ① R2 数据恢复
       │  rclone sync r2:bucket/openclaw/ → /root/.openclaw/
       │  rclone sync r2:bucket/workspace/ → /root/clawd/
       │  rclone sync r2:bucket/skills/ → /root/clawd/skills/
       │
       ▼
  ② 首次 Onboarding（如无配置文件）
       │  openclaw onboard --non-interactive
       │  配置 AI 提供商、端口、绑定模式
       │
       ▼
  ③ 配置补丁（Node.js 内联脚本）
       │  设置网关令牌
       │  配置消息渠道（Telegram/Discord/Slack）
       │  设置可信代理 IP
       │
       ▼
  ④ 启动后台 R2 同步循环（每 30 秒）
       │
       ▼
  ⑤ openclaw gateway --port 18789 --verbose --bind lan
```

### 3. 认证体系

系统采用三层认证架构：

```
┌─────────────────────────────────────────────────────────────┐
│                    第一层：Cloudflare Access                  │
│                                                             │
│  • JWT 来源：CF-Access-JWT-Assertion 头 或 CF_Authorization │
│    cookie                                                   │
│  • 验证：jose 库 + JWKS 远程密钥集                          │
│  • 结果：提取 email + name 存入上下文                        │
│  • 跳过条件：DEV_MODE=true 或 E2E_TEST_MODE=true           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                 第二层：网关令牌 (MOLTBOT_GATEWAY_TOKEN)      │
│                                                             │
│  • Worker 自动注入到 WebSocket URL 的 ?token= 参数          │
│  • CF Access 重定向会丢失查询参数，所以服务端补注入          │
│  • 容器内 OpenClaw 网关验证此令牌                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   第三层：设备配对                            │
│                                                             │
│  • 新设备首次连接需要管理员在 Admin UI 中批准                │
│  • 调用 openclaw devices approve <requestId> CLI             │
│  • DEV_MODE 下跳过配对验证                                   │
│  • E2E_TEST_MODE 下仍保留配对验证                            │
└─────────────────────────────────────────────────────────────┘

特殊认证：CDP 路由
  • 使用独立的 CDP_SECRET 查询参数
  • timing-safe 比较防止时序攻击
  • 不经过 CF Access 认证流程
```

### 4. R2 持久化和同步机制

```
                    容器内数据
            ┌───────────────────────┐
            │  /root/.openclaw/     │ ─── 配置文件（openclaw.json 等）
            │  /root/clawd/         │ ─── 工作区文件
            │  /root/clawd/skills/  │ ─── 自定义技能
            └──────────┬────────────┘
                       │
           ┌───────────┼───────────────┐
           │     rclone sync           │
           │  --transfers=16           │
           │  --fast-list              │
           │  --s3-no-check-bucket     │
           │  排除: *.lock, *.log,     │
           │        *.tmp, .git/**     │
           └───────────┼───────────────┘
                       │
                       ▼
            ┌───────────────────────┐
            │  Cloudflare R2 Bucket │
            │  (moltbot-data)       │
            │                       │
            │  /openclaw/  ← 配置   │
            │  /workspace/ ← 工作区 │
            │  /skills/    ← 技能   │
            └───────────────────────┘

同步触发方式：
  1. 容器启动时：R2 → 容器（恢复数据）
  2. 后台循环：容器 → R2（每 30 秒检查变更）
  3. Admin API：POST /api/admin/storage/sync（手动触发）
```

### 5. 设备配对流程

```
新设备连接 WebSocket
       │
       ▼
  OpenClaw 网关发现新设备
       │  生成 requestId
       │
       ▼
  管理员访问 /_admin/ 页面
       │
       ▼
  Admin UI 轮询 GET /api/admin/devices
       │  展示待配对设备列表
       │
       ▼
  管理员点击「批准」
       │
       ▼
  POST /api/admin/devices/:requestId/approve
       │
       ▼
  Worker 在容器内执行 CLI:
  openclaw devices approve <requestId> \
    --url ws://localhost:18789 \
    --token <GATEWAY_TOKEN>
       │
       ▼
  设备配对完成，可以正常通信
```

### 6. CDP 浏览器自动化

```
外部 CDP 客户端
       │
       ▼
  GET /cdp?secret=<CDP_SECRET>  (WebSocket 升级)
       │
       ▼
  验证 secret（timing-safe 比较）
       │
       ▼
  创建 WebSocket 对（客户端 ↔ 服务端）
       │
       ▼
  初始化 Puppeteer 浏览器实例
  (通过 Cloudflare Browser Rendering)
       │
       ▼
  创建初始页面，发送 Target.targetCreated 事件
       │
       ▼
  进入 JSON-RPC 消息循环:
       │
       ├─ Browser.getVersion / Browser.close
       ├─ Target.createTarget / closeTarget / getTargets
       ├─ Page.navigate / captureScreenshot / setContent / printToPDF
       ├─ Runtime.evaluate / callFunctionOn
       ├─ DOM.getDocument / querySelector / getOuterHTML
       ├─ Input.dispatchMouseEvent / dispatchKeyEvent
       ├─ Network.setCookie / getCookies / setUserAgentOverride
       ├─ Emulation.setDeviceMetricsOverride / setGeolocationOverride
       └─ Fetch.enable / continueRequest / fulfillRequest
```

---

## 关键模块详解

### 核心模块

| 模块 | 文件 | 行数 | 核心职责 |
|------|------|------|---------|
| **主入口** | `src/index.ts` | 449 | Hono 应用、中间件链、WebSocket 双向代理、错误消息转换 |
| **CDP 代理** | `src/routes/cdp.ts` | 1919 | Chrome DevTools Protocol 子集实现，Puppeteer 浏览器自动化 |
| **Admin UI** | `src/client/pages/AdminPage.tsx` | 410 | 设备管理、存储状态、网关控制的 React 管理界面 |
| **调试路由** | `src/routes/debug.ts` | 389 | 进程列表、日志查看、CLI 执行、环境检查、容器配置 |
| **API 路由** | `src/routes/api.ts` | 301 | 设备 CRUD、R2 同步触发、网关重启的 RESTful API |
| **启动脚本** | `start-openclaw.sh` | 329 | R2 恢复、Onboarding、配置补丁、后台同步、网关启动 |

### 认证模块

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/auth/middleware.ts` | 151 | Hono 中间件工厂，支持 JSON/HTML 响应，DEV/E2E 模式跳过 |
| `src/auth/jwt.ts` | ~50 | jose 库验证 CF Access JWT，JWKS 远程密钥获取 |

### 网关管理模块

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/gateway/process.ts` | 139 | 进程查找（支持新旧命名）、启动、端口等待、健康检查 |
| `src/gateway/env.ts` | 59 | Worker 环境变量 → 容器环境变量映射，支持三种 AI 提供商配置 |
| `src/gateway/r2.ts` | 45 | rclone 配置文件生成和写入，幂等标志检查 |
| `src/gateway/sync.ts` | 86 | 容器 → R2 数据同步，配置/工作区/技能三部分同步 |
| `src/gateway/utils.ts` | 28 | 进程状态轮询等待工具 |

---

## API 接口清单

### 公开路由（无认证）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/sandbox-health` | 容器健康检查，返回 `{ status: 'ok' }` |
| `GET` | `/api/status` | 网关运行状态，返回 `{ ok, status, processId }` |
| `GET` | `/logo.png` | Logo 静态资源 |
| `GET` | `/logo-small.png` | 小尺寸 Logo |
| `GET` | `/_admin/assets/*` | Admin UI 静态资源（CSS/JS） |

### CDP 路由（`?secret=CDP_SECRET` 认证）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/cdp` | WebSocket 端点，Chrome DevTools Protocol 代理 |
| `GET` | `/cdp/json/version` | 浏览器版本信息 + WebSocket 调试 URL |
| `GET` | `/cdp/json/list` | 可用目标（标签页）列表 |
| `GET` | `/cdp/json` | 同 `/cdp/json/list` |

### Admin API（Cloudflare Access JWT 认证）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/admin/devices` | 列出待配对和已配对设备 |
| `POST` | `/api/admin/devices/:requestId/approve` | 批准单个设备 |
| `POST` | `/api/admin/devices/approve-all` | 批准所有待配对设备 |
| `GET` | `/api/admin/storage` | R2 存储配置状态和最后同步时间 |
| `POST` | `/api/admin/storage/sync` | 手动触发容器 → R2 同步 |
| `POST` | `/api/admin/gateway/restart` | 重启 OpenClaw 网关进程（异步） |

### Admin UI（Cloudflare Access JWT 认证）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/_admin/*` | React SPA 入口（所有路径返回 index.html） |

### 调试路由（Cloudflare Access + `DEBUG_ROUTES=true`）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/debug/version` | 容器内 openclaw 和 node 版本 |
| `GET` | `/debug/processes` | 所有容器进程列表（`?logs=true` 含日志） |
| `GET` | `/debug/gateway-api` | 探测网关 HTTP API（`?path=/`） |
| `GET` | `/debug/cli` | 在容器内执行 CLI 命令（`?cmd=openclaw --help`） |
| `GET` | `/debug/logs` | 获取进程日志（`?id=<process-id>`） |
| `GET` | `/debug/ws-test` | WebSocket 交互调试页面 |
| `GET` | `/debug/env` | 脱敏的环境变量状态（仅布尔值） |
| `GET` | `/debug/container-config` | 读取容器配置文件 |

### 代理路由（Cloudflare Access JWT 认证）

| 方法 | 路径 | 说明 |
|------|------|------|
| `ALL` | `/*` | 所有未匹配路由代理到 OpenClaw 网关 (:18789)，支持 HTTP 和 WebSocket |

---

## Cloudflare 服务集成

### Sandbox Containers

- **Durable Object**: `Sandbox` 类管理容器实例
- **容器类型**: `standard-1`（单实例）
- **镜像**: 基于 `cloudflare/sandbox:0.7.0`，预装 Node.js 22 + OpenClaw
- **核心 API**:
  - `sandbox.startProcess()` — 启动容器进程
  - `sandbox.listProcesses()` — 列出运行中的进程
  - `sandbox.containerFetch()` — HTTP 代理到容器
  - `sandbox.wsConnect()` — WebSocket 代理到容器
  - `sandbox.exec()` — 执行容器内命令
  - `sandbox.writeFile()` — 写入容器文件

### R2 对象存储

- **Bucket**: `moltbot-data`（可通过 `R2_BUCKET_NAME` 覆盖）
- **用途**: 持久化 OpenClaw 配置、工作区和自定义技能
- **访问方式**: 通过 rclone S3 兼容 API（非 Workers R2 绑定）
- **同步策略**: `rclone sync`（传播删除），16 并发传输

### Cloudflare Access

- **认证方式**: JWT 验证（JWKS 远程密钥集）
- **配置**: `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`
- **中间件**: 支持 JSON 和 HTML 两种响应格式
- **服务令牌**: E2E 测试使用 `CF-Access-Client-Id` + `CF-Access-Client-Secret`

### Browser Rendering

- **绑定**: `BROWSER` (Fetcher)
- **用途**: 通过 `/cdp` 端点提供 Chrome DevTools Protocol 代理
- **库**: `@cloudflare/puppeteer` v1.0.5
- **支持**: 页面导航、截图、PDF 生成、DOM 操作、网络拦截等

### Static Assets

- **绑定**: `ASSETS` (Fetcher)
- **目录**: `./dist/client`（Vite 构建输出）
- **用途**: Admin UI 的 SPA 前端资源

---

## 配置和环境变量

### 必需变量

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥（至少需要一个 AI 提供商密钥） |

### AI 提供商配置（三选一）

**方式 1：直接提供商密钥（推荐）**

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 |
| `ANTHROPIC_BASE_URL` | 可选，自定义 Anthropic API 端点 |
| `OPENAI_API_KEY` | OpenAI API 密钥 |

**方式 2：Cloudflare AI Gateway（备选）**

| 变量 | 说明 |
|------|------|
| `CF_AI_GATEWAY_ACCOUNT_ID` | AI Gateway 账户 ID |
| `CF_AI_GATEWAY_GATEWAY_ID` | AI Gateway 网关 ID |
| `CLOUDFLARE_AI_GATEWAY_API_KEY` | AI Gateway API 密钥 |
| `CF_AI_GATEWAY_MODEL` | 可选，模型覆盖（如 `workers-ai/@cf/openai/gpt-oss-120b`） |

**方式 3：旧版 AI Gateway（已弃用）**

| 变量 | 说明 |
|------|------|
| `AI_GATEWAY_BASE_URL` | AI Gateway 端点 URL |
| `AI_GATEWAY_API_KEY` | AI Gateway API 密钥 |

### 认证变量

| 变量 | 说明 |
|------|------|
| `MOLTBOT_GATEWAY_TOKEN` | 网关访问令牌，Worker 自动注入到 WebSocket 连接 |
| `CF_ACCESS_TEAM_DOMAIN` | Cloudflare Access 团队域名（如 `myteam.cloudflareaccess.com`） |
| `CF_ACCESS_AUD` | Cloudflare Access Application Audience Tag |

### 消息渠道变量

| 变量 | 说明 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |
| `TELEGRAM_DM_POLICY` | Telegram DM 策略（如 `pairing`） |
| `DISCORD_BOT_TOKEN` | Discord Bot Token |
| `DISCORD_DM_POLICY` | Discord DM 策略 |
| `SLACK_BOT_TOKEN` | Slack Bot Token |
| `SLACK_APP_TOKEN` | Slack App Token |

### R2 持久化变量

| 变量 | 说明 |
|------|------|
| `R2_ACCESS_KEY_ID` | R2 API 密钥 ID |
| `R2_SECRET_ACCESS_KEY` | R2 API 密钥 |
| `CF_ACCOUNT_ID` | Cloudflare 账户 ID（用于 R2 端点构建） |
| `R2_BUCKET_NAME` | 可选，覆盖默认 bucket 名称 `moltbot-data` |

### 浏览器自动化变量

| 变量 | 说明 |
|------|------|
| `CDP_SECRET` | /cdp 端点的共享密钥 |
| `WORKER_URL` | Worker 的公共 URL（用于生成 WebSocket 调试 URL） |

### 模式标志

| 变量 | 说明 |
|------|------|
| `DEV_MODE` | `'true'` 跳过 CF Access 认证 + 设备配对 |
| `E2E_TEST_MODE` | `'true'` 跳过 CF Access 认证，保留设备配对 |
| `DEBUG_ROUTES` | `'true'` 启用 `/debug/*` 路由 |
| `SANDBOX_SLEEP_AFTER` | 容器休眠时间（`'never'`、`'10m'`、`'1h'`） |

---

## 测试体系

### 单元测试（Vitest）

- **框架**: Vitest 4 + V8 覆盖率
- **环境**: Node.js
- **文件模式**: `src/**/*.test.ts`（排除 `src/client/**`）
- **运行**: `npm test` / `npm run test:watch` / `npm run test:coverage`

**测试覆盖的模块：**

| 测试文件 | 行数 | 覆盖内容 |
|----------|------|---------|
| `src/auth/jwt.test.ts` | 147 | JWT 验证逻辑 |
| `src/auth/middleware.test.ts` | 266 | 认证中间件（DEV/E2E/正常模式） |
| `src/gateway/process.test.ts` | ~100 | 进程查找和启动 |
| `src/gateway/env.test.ts` | 161 | 环境变量映射 |
| `src/gateway/r2.test.ts` | ~80 | rclone 配置生成 |
| `src/gateway/sync.test.ts` | 158 | R2 同步逻辑 |
| `src/logging.test.ts` | ~50 | URL 参数脱敏 |

### E2E 测试

- **工具链**: cctr (CLI 语料库测试运行器) + plwr (浏览器自动化 CLI) + Playwright
- **基础设施**: Terraform 管理（Access 应用、服务令牌、R2 Bucket）
- **部署**: Wrangler 自动部署独立 Worker 实例

**测试矩阵（4 个配置并行运行）：**

| 配置 | 描述 | 特殊变量 |
|------|------|---------|
| `base` | 基础部署测试 | — |
| `telegram` | Telegram 集成 | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_DM_POLICY=pairing` |
| `discord` | Discord 集成 | `DISCORD_BOT_TOKEN`, `DISCORD_DM_POLICY=pairing` |
| `workers-ai` | Workers AI 模型 | `CF_AI_GATEWAY_MODEL=workers-ai/@cf/openai/gpt-oss-120b` |

**E2E 测试流程：**

```
1. Terraform Apply → 创建 Access 服务令牌 + R2 Bucket
2. Wrangler Deploy → 部署 Worker (moltbot-sandbox-e2e-{run-id})
3. Create Access App → 创建 Access 应用 + 策略
4. plwr 启动浏览器 → 打开 Worker URL
5. 执行测试场景:
   - 导航到管理页面
   - 等待并批准待配对设备
   - 导航到聊天页面
   - 发送消息并验证回复
6. 停止录屏，生成缩略图
7. Terraform Destroy → 清理所有资源
```

---

## CI/CD 和部署

### GitHub Actions 工作流 (`.github/workflows/test.yml`)

**触发条件：** push/PR 到 main，手动触发

```
┌──────────────────────────────┐    ┌──────────────────────────────────┐
│       Unit Tests (unit)      │    │       E2E Tests (e2e)            │
│                              │    │                                  │
│  Node 22                     │    │  Node 22 + Terraform + ffmpeg    │
│  npm ci                      │    │                                  │
│  npm run lint (oxlint)       │    │  Matrix: base, telegram,         │
│  npm run format:check        │    │          discord, workers-ai     │
│  npm run typecheck           │    │                                  │
│  npm test (vitest)           │    │  cctr run test/e2e/ --timeout 7m │
│                              │    │                                  │
│  ✓ 通过后可合并              │    │  产物:                            │
└──────────────────────────────┘    │  - 视频录制 → e2e-artifacts 分支  │
                                    │  - 缩略图 → PR 评论               │
                                    │  - 失败截图                       │
                                    └──────────────────────────────────┘
```

### 手动部署

```bash
# 构建并部署
npm run deploy        # = npm run build && wrangler deploy

# 设置密钥
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put MOLTBOT_GATEWAY_TOKEN
wrangler secret put CF_ACCESS_TEAM_DOMAIN
wrangler secret put CF_ACCESS_AUD
# ... 其他密钥

# 本地开发
npm run start         # = wrangler dev
npm run dev           # = vite dev (仅前端)
```

### 容器镜像更新

修改 `Dockerfile` 后，Wrangler 会在 `wrangler deploy` 时自动构建并推送容器镜像。关键版本号：

- **基础镜像**: `cloudflare/sandbox:0.7.0`
- **Node.js**: `22.13.1`
- **OpenClaw**: `2026.2.3`（通过 `pnpm add -g openclaw@2026.2.3`）
- **缓存标记**: `Dockerfile` 中的 `CACHE_BUST` ARG 控制重建
