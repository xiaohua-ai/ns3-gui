# EPComHIL Windows 上位机先行版 · 实现与优化计划

依据《架构设计说明书》制定。**先行版范围 = Windows 上位机完整链路：界面建模 → 配置 → 校验 → 代码生成 → 导出 ns-3 项目代码（本地目录产物）**。Linux 端 ns-3、HIL 同步、半实物为后续阶段，暂不实现；先行版的仿真输入用**模拟 / 中间输出**驱动测试。

---

## 一、范围与边界（先行版）

| 项 | 先行版 | 后续阶段 |
|---|---|---|
| 运行环境 | Windows 上位机（Electron） | Linux 仿真服务 / ns-3.38 |
| 拓扑建模 / 配置界面 | ✅ 实现 | — |
| 数据模型 + JSON 中间态 + 校验 | ✅ 实现 | — |
| 代码生成 | ✅ 实现（NS3-3 段生成） | 接入真实 ns-3 消费 |
| 导出 ns-3 项目代码 | ✅ 实现（本地工程目录 + 可直接 `ns3 build/config` 的产物骨架） | 上传 / 联动 Linux 启动 |
| 仿真运行 / 可视化 / HIL / 半实物 / gRPC 后端 | 🟡 已打通「仿真机实跑 + Runtime 回灌 + 离线/实时查看」（见第六节）；gRPC 后端仍暂缓 | L1~L3 |

**先行版技术栈**：Electron + Vue3 + TypeScript + Vite + AntV X6（拓扑）+ ECharts（图表）+ Element Plus（深色工业主题）+ Pinia + Vue Router。
**生成器承载位置**：放 Electron **主进程（Node/TS 侧）**，渲染进程经 IPC 调用 —— 这样后续接 Linux 后端时，仅把"调用生成器"从 IPC 换成 gRPC，生成器本体不变。

---

## 二、实现步骤（W1→W9）

### W1 工程骨架初始化
- 单仓：`src/main`（Electron 主进程）、`src/renderer`（Vue3）、`src/generator`（代码生成，Node/TS）、`src/core`（数据模型）、`test/`、`samples/`。
- Vite + Electron 开发模式（HMR）；`samples/` 放 mock 工况 JSON。
- **验收**：`npm run dev` 起 Electron 空壳，渲染进程可达。

### W2 UI 整体框架
- 主导航（流程式）：欢迎 / 场景与工况库 / 工程管理 / 拓扑建模 / 配置 / 导出。
- 布局：左侧导航 + 顶部工具条（模式切换、启动模拟、导出）；右侧留 **实时详情侧栏**（对应架构 5.1）。
- 深色工业主题（Element Plus dark）。
- **验收**：各页面路由可切换，顶部常驻操作按钮可见。

### W3 拓扑建模页（AntV X6）
- 组件库：通用通信设备 + 电力终端节点（IED / RTU / 光伏 / 储能 / 负荷等）。
- 拖拽组网、链路连接（P2P / CSMA / 无线占位）、节点/链路属性编辑、布局持久化（JSON）。
- **验收**：可搭出 ≥5 节点拓扑并保存加载。

### W4 配置页
- 节点配置、协议配置（IEC 61850 MMS/GOOSE、Modbus——区分 L2/L3，架构 7.4）、业务报文流对话框（定时遥测/突发遥信/控制下发/CBR/OnOff + 随机分布）、半实物接入配置（虚拟网卡+节点映射+单网口，占位）、HIL/时钟源配置（PTP/内置，占位）。
- **验收**：可为一个节点配置协议与业务流，可编辑/删除。

### W5 数据模型 + `IGenElement`（TS 实现）
- 拓扑对象模型 + 统一契约 `IGenElement{ id; validate; forSettings; toCode }`；具体实现：`NodeElement / LinkElement / ProtocolElement / FaultElement / HalfPhysicalElement`。
- 电力节点模板（IED/RTU/光伏/储能）。
- **验收**：单测覆盖 `validate` 与 `toCode` 片段。

### W6 JSON 中间态 + Validator
- 按架构附录 C 定义 `topology / protocol / halfphysical / hil` JSON schema；`Validator` 校验 id↔配置↔半实物一致性、协议参数合法、流目标非悬空，失败定位字段。
- **验收**：构造错误工况可精确报错并阻断导出。

### W7 代码生成器（Node 侧，核心）
- `ElementEmitter`（多态分派收集 toCode）+ `SectionBuilder`（Header→参数→节点→链路→协议→业务流→HIL/半实物注入→采集→主函数）+ `InjectSwitcher`（离线/HIL、precise/rough、`--offline`）+ `OutputWriter`。
- 产物：**自包含 ns-3 C++ 脚本（`.cc`）**，不依赖运行期 JSON（架构 7.3 / 7.7）。
- **验收**：同一拓扑产出稳定 `.cc`，快照比对通过；生成日志含每条规则命中说明。

### W8 导出模块（先行版终点）
- 「导出 ns-3 项目」：本地创建 `Designed_<timestamp>/` 工程目录——`.cc` 源码、`CMakeLists` 描述（便于二次用 ns-3 编译）、JSON 中间态副本、构建/运行说明、CLI 说明；可选打包 `.zip`。
- **中间输出用于测试**：导出面板展示「中间 JSON → 校验报告 → 生成日志 → 最终 .cc」四层，可逐层查看/下载，便于人工在真实 ns-3 落地前核对正确性。
- **验收**：导出后目录结构符合附录 C，`.cc` 可读、字段完整、JSON 与 .cc 双向可追溯。

### W9 测试与交付
- 单元测试：`IGenElement` 契约、Validator 拒绝用例、生成器**快照比对**（回归防漂移）。
- 组件测试 + 简单端到端（建模→配置→导出）。
- 用例库：`samples/` 内置 Simple / Complex 工况（含电力业务流）。
- **交付**：Windows 安装包（Electron Builder）+ 导出规范说明（供后续 Linux 端按契约消费）。

---

## 三、先行版优化计划

| 方向 | 优化措施 | 作用 / 依据 |
|---|---|---|
| **一次成型 / 避免返工** | 数据模型先行（W5 在 UI 联调前完成），UI 只消费模型，杜绝两套数据 | 架构 5.8「UI 与生成解耦」 |
| **生成器可移植** | 生成器放主进程 Node 侧、经 IPC 调用；后续仅换调用面为 gRPC | 架构 5.10，Linux 端平滑接入 |
| **回归安全** | 生成用**快照比对** + 错误工况反例库，防代码生成漂移 | 架构 7.6 校验防误配 |
| **协议承载分层** | GOOSE（L2 二层帧）与 MMS/Modbus（L3 Socket）分两条生成路径，从先行版即固化 | 架构 7.4 与 ns-3 对齐 |
| **可观察性** | 导出面板「中间 JSON / 校验报告 / 生成日志 / .cc」四层可见，先行版便于人工校对 | 架构 6.2 现场留存 |
| **前置可测** | 无 Linux/ns-3 时以 mock 工况驱动全流程，先行版即可完整验证模型与生成正确性 | 降低 L0 联调风险 |

---

## 四、后续阶段（确认先行版后再启动）

1. **L1**：gRPC 契约 + Node/后端对接（生成调用从 IPC 换 gRPC）+ OutputOrchestrator + 真实可视化流。
2. **L2**：Linux ns-3 服务、保守同步引擎、仿真器对接、双模式/时钟源、协议 L2/L3 落地。
3. **L3**：半实物单网口接入、插件化与安全加固、验收。
> 先行版导出的 `.cc` 与 JSON 即作为 L1/L2 的消费输入契约。

---

## 五、里程碑

| 里程碑 | 定义 | 验证 |
|---|---|---|
| M0 | 骨架 + UI 框架可运行 | Electron 起壳、路由可切 |
| M1 | 建模 + 配置可用 | 5 节点拓扑 + 协议/业务流配置 |
| M2 | 校验 + 代码生成稳定 | 快照比对、反例阻断 |
| M3 | **导出 ns-3 项目代码（先行版交付）** | 导出目录规范、.cc 可核、mock 工况全流程跑通 |
| M4 | **仿真机上机运行 + 结果回灌 Runtime 监视台** | 9 条分支产物实机编译零告警；Runtime 组件有数据、且能绑定到具体节点 |
| M5 | **离线 / 实时两种查看方式成立** | OFFLINE 曲线一次铺满；HIL 曲线随墙钟逐拍滚动（1s/拍，实测 10s 仿真 10s 墙钟） |

> 建议按 W1→W9 顺序推进，M2（生成稳定）为核心质量关卡。确认计划后，默认从 W1 开始实现。

---

## 六、已落地里程碑：仿真机上机运行 + 结果回灌 Runtime（M4 / M5）

先行版最初只做到"导出 `.cc`"，运行结果落到 Linux 侧日志文件、平台拿不到。本节记录**把运行结果接回本平台 Runtime 监视台**的完整链路、构建计划，以及离线 / 实时两种模式的查看方式。

### 6.1 链路总览（一条通道，两种投递节奏）

```
工程(拓扑/配置) ──generate()──▶ 自包含 ns-3 .cc
                                    │  SFTP 上传 → scratch/<场景>.cc
                                    ▼
                    ./ns3 build <场景>     （目标级构建，不编整树）
                                    ▼
              ┌── OFFLINE ──▶ ./ns3 run <场景>          （全速推进）
              └── HIL     ──▶ ./build/scratch/ns3.38-<场景>-default  （RealtimeSimulatorImpl，按墙钟）
                                    ▼
              产物 stdout 逐块 ──SSH execStream──▶ 主进程 onEvent(phase/line/exit)
                                    ▼
                    simOutput.ts 有状态解析器（stdout/stderr 双缓冲、按整行、flush 收尾）
                                    ▼
              runtime store.ingest()  ←—— 与 mock 数据完全同一个入口
                                    ▼
                    Runtime 监视台组件（通信指标 / GOOSE / HIL 同步 / 硬件在环 / 操作日志）
```

**关键设计**：离线与实时**走同一条通道、同一个解析器、同一个 ingest**，差别只在产物侧是否绑定 `RealtimeSimulatorImpl`。因此组件侧对模式完全无感，不需要两套代码。

### 6.2 构建计划（已执行的步骤）

| # | 步骤 | 产物 / 验收 |
|---|---|---|
| 1 | 产物侧补**运行遥测**：`[EPC-OP]`/`[EPC-KPI]`/`[EPC-HIL]`/`[EPC-TAP]` 四类行，前缀在 `src/core/simOutput.ts` 单点定义，生成器与解析器同源 | 前缀两侧成对，断了只会"静默无数据" → 由 `ns3-products.test.ts` 钉死 |
| 2 | `[EPC-KPI]` 补**流端点**：`Ipv4FlowClassifier::FindFlow()` 取五元组，发 `src=IP:port dst=IP:port proto=` | 平台不依赖 ns-3 流号顺序即可把曲线绑到"哪台机→哪台机" |
| 3 | 平台侧 `core/flowIndex.ts` + `generator/context.ts#buildFlowIndex`：按**与生成器同一份 IP 规划**把端点还原成节点 / 业务流 | 工程 `flows` 为空也能绑定（内置案例「P2P主从UDP」正是，实测 `flows=0` 绑定仍 7/7 命中） |
| 4 | `matchesBinding` 节点作用域改「**两端任一命中**」 | 绑定接收端（服务端）不再恒空 |
| 5 | 主进程 `serverMonitor.cjs#runScenario`：上传 → 目标级构建 → 运行 → 逐块回推；stdout/stderr 分通道 | 编译错误能识别成错误级日志，不被伪装成普通输出 |
| 6 | 9 条代表分支固化为产物契约用例（含多接口节点 / 半实物 / HIL / 重名转义） | 实机 9/9 编译通过、零告警 |
| 7 | HIL 前置检查（tap 存在且 `state UP`） | 把"一行无主 abort"换成指名到 tap 的可操作提示 |
| 8 | 浏览器回退桥：vite `serverStatusPlugin` 提供 `/__epcomhil_sim_run` + SSE | 无 Electron 时（直接开 localhost:5173）Runtime 页仍可真实驱动运行 |
| 9 | 第五类行 `[EPC-LINK]`：链路级 MAC 计数（`MacTx`/`MacRx`/`MacTxDrop`/`PhyRxDrop`，两端求和，按 `link=` 报出） | 「通信指标」绑定**链路**不再恒空；pdr 按 `1-drop/tx`（csma 扇出使 rx>tx）；链路视图无时延 |

### 6.3 离线运行后如何查看

1. 打开内置案例（拓扑页 → 自带案例库 → 选例），或搭好自己的拓扑；
2. 进 **Runtime** 页，若监视台是空的点一次「**一键布局**」（放入五种监视组件）；
3. 点「**离线运行**」→ 顶部阶段徽标依次走 连接仿真机 → 上传产物 → 构建中 → 运行中 → **已完成**；
4. 查看方式：**曲线一次铺满**。因为 ns-3 全速推进，10s 仿真通常 1~2s 跑完，所有遥测同一时刻到齐 —— 适合**回看、截图、与报告比对**。
5. 左侧「运行日志」是全量构建+运行输出（遥测行与逐包行不进日志，避免把编译错误淹掉）；右侧「操作日志」组件是产物自己报的操作流水。

### 6.4 实时运行（HIL）如何查看

1. 同上进入 Runtime 页；
2. 点「**实时运行**」→ 产物绑定 `RealtimeSimulatorImpl`，仿真时间与墙钟对齐、**绝不超前**；
3. 查看方式：**曲线随仿真实时滚动**。每 1s 墙钟推进 1s 仿真时间，「HIL 同步」组件同期刷新（时钟源 / 步长 / 抖动 / 降级位）。实测 10s 仿真耗时 10.07s 墙钟、`[EPC-HIL]` 十条 tick 间隔精确 1000ms（严格对照见 §6.6）。
4. 半实物产物需先在仿真机备好 tap（`ip tuntap add` + `ip link set up`）并汇入网桥；缺失时平台会在「运行前置检查」阶段快速失败并给出确切命令，不会跑到一半 abort。

### 6.5 踩坑纪律（改动时务必遵守）

| 纪律 | 成因 | 违反后的症状 |
|---|---|---|
| 遥测前缀 / 字段名在 `core/simOutput.ts` 单点定义，生成器与解析器同源 | 两处各写一份常量，改一处就断 | 产物照跑、页面照开，只是 Runtime 组件**永远空着**（不报错，最难查） |
| HIL 的 `GlobalValue::Bind("SimulatorImplementationType", ...)` 必须排在 main 体**第一条**、早于任何 `Simulator::` 调用（含启动遥测里的 `Simulator::Now()`） | `Simulator::GetImpl()` 是懒加载单例：首次触碰即按当时的 GlobalValue 缓存实现，之后 `Bind` 只改默认值、换不掉已缓存实例 | HIL **静默退化成全速仿真**：10s 仿真 1ms 跑完、曲线不滚动，jitter 线性涨到 ~9s（看着像同步坏了，其实是根本没上实时仿真器） |
| HIL 步进引擎等被 `Simulator::Schedule` 长期引用的对象必须声明为**函数内 static** | `&sync` 存进事件队列后会活到 if 块之外；普通块内局部量在块尾即销毁 | 后续 tick 读悬垂内存：第一步读数正常，第二步起 `step`/预算被邻居栈槽改写、降级位从第 3 步起永久为 1（同类坑见半实物 `EpcTapCounter`） |

### 6.6 实时性「真的跑满 10s」A/B 验证记录

**为什么还要再验一次**：§6.4 那句"每拍间隔精确 1000ms"只跑了**实时分支** —— 算得慢、或每拍空转，读数一样。
要证明"按墙钟 1:1 推进"，必须做**只差一处的对照**，并绕开平台自己的时间戳。

**对照设计**：同一份 `hil_mode.cc` 落成两个 scratch 目标，**唯一差异**是
`if (hil) { GlobalValue::Bind("SimulatorImplementationType", …RealtimeSimulatorImpl…); }` 这一块
（`hil_rt` 保留 / `hil_nort` 删掉）；拓扑、应用、`Stop(Seconds(10))` 全不动。
脚本跑前先断言该块**恰好出现 1 次**，否则"A/B 只差一行"不成立。

**实测**（计时全部在仿真机本地用 `date +%s%N` 掐表，平台不参与）：

| 指标 | 实时 `hil_rt` | 对照 `hil_nort` |
|---|---|---|
| REAL（墙钟） | **10.07 s** | **0.06 s** |
| USER（CPU） | 0.06 s | 0.06 s |
| HIL tick / KPI tick | 10 / 7 | 10 / 7 |
| 末次 jitter | 359 μs | 8 998 938 μs（≈9 s） |
| Flow 统计 | Tx=8 Rx=8 PDR 100% | 同 |

同一份产物、同样 10s 仿真时间、同样收发 8 包 → 墙钟差 **167×**；
`REAL≈10s` 而 `USER≈0.06s` → 进程 99% 时间在**等**墙钟，不是在算。
重复 3 次：**10072 / 10071 / 10071 ms**（毫秒级可复现）。
平台侧通道（Runtime 实际走的那条）：`running 1.64s → exit 11.81s` = **10.17 s**，10 条 tick 间隔精确 1000ms。

**结论**：实时模式确实按墙钟 1:1 走完 10s，全程偏差 < 0.4 ms（万分之 0.36）。

**读数据时的一个坑（容易误判成 bug）**：对照组 `jitter=8998938` 却 `degraded=0`，乍看像降级逻辑坏了。
实际自洽 —— `HilStepGuardian::Step()` 里 `drift = 墙钟已走 − 应到的仿真时刻`：
全速跑完时墙钟≈1ms、应到 9s → drift 为**负**（仿真**超前**墙钟）→ `drift <= budget` 通过 → 不降级；
而遥测打印的是 `abs(drift)`（组件要展示"抖动幅度"）。
**即：正 drift 才是"算力不足"，负 drift 是"跑太快"。**

### 6.7 三种模式与「从日志判断跑没跑实时」

`SimMode` 是**三值**：`OFFLINE` / `REALTIME` / `HIL`。Runtime 页两个按钮的取值为：
「离线运行」→ `OFFLINE`；「实时运行」→ 工程模式为 `HIL` 时用 `HIL`，否则用 **`REALTIME`**
（`RuntimeView.onRunRealtime`：运行设置为 OFFLINE 时按 REALTIME 处理，保证"实时"语义成立）。

REALTIME 与 HIL 的产物差异：REALTIME 是**无条件**绑定 `ns3::RealtimeSimulatorImpl`（无步进引擎、
不消费 `--hil`、不发 `[EPC-HIL]` 遥测）；HIL 额外带保守步进引擎与半实物装配。

**从日志判断"是否真的实时跑满 N 秒"，靠总耗时是可行的，但必须先有基线区间**
（同机实测，`res.duration` 覆盖连接→上传→构建→运行全程）：

| 构建形态 | 构建耗时 | OFFLINE 10s 总耗时 | REALTIME 10s 总耗时 |
|---|---|---|---|
| 无改动（ninja 空转） | 185 ms | ~1.4 s | ~11.4 s |
| 已有 target 重编（ccache 命中） | 0.67~0.77 s | ~2.0 s | **~12.0 s** |
| **新 target 首编**（cmake 重新 glob） | 5.2 s | ~6.4 s | ~16.4 s |

**读法**：先扣掉连接+上传（≈0.86s），再用"哪个假设会得出物理上不可能的阶段耗时"排除
（`Stop(Seconds(10))` 下，实时必 ≥10s、全速 ≈0.4s，中间值不存在）。
因 `窗口/时长` 目前没有 UI 入口（`setRun` 无调用方），`stopSeconds` 恒为 10。

> **自 §6.8 起，本节下表降级为兜底读法**：日志已逐行带时间标签，
> `[done] − [running]` 直接就是运行阶段耗时，不必再反推。此表只在"手头只有聚合耗时"
> （如别人发来一行 `✓ 运行完成 · 11.9s`）时才有用。

**已修的历史缺陷**：SSH 通道曾写 `p.mode === 'HIL' ? 'HIL' : 'OFFLINE'`，
把 REALTIME **静默塌成 OFFLINE** → 阶段行打 `· OFFLINE`，而日志首行（store 侧）写 `· REALTIME`，
同一块界面两个模式名打架。**注意它是标签错、不是跑错**：产物实时与否由生成器烧进 `.cc`，
通道侧 `mode` 只决定走哪条运行命令、要不要做 tap 前置检查。现已三值都认。

### 6.8 运行日志逐行时间标签（把 §6.7 的"读法"变成日志自身的属性）

§6.7 那套"扣掉连接上传 + 用物理不可能排除"是**读数技巧**，不是日志该有的样子：
总耗时把连接/上传/构建/运行揉成一个数，而"跑没跑满 10s"问的是其中**一段**。
现在每行日志自带时间标签，减法即答案。

**落点（一次成型，不打在组件上）**：时间进的是**行模型**，不是渲染时的前缀拼接。
`src/core/runLog.ts` 定义 `RunLogLine { seq, tMs, atMs, text }`；
store 的 `pushLog` 是运行日志的**唯一写入口**，四个来源（阶段行 / 产物 stdout /
产物 stderr / 平台侧提示）都经它 —— 因此"每行都有时间标签"是结构上成立的。

| 设计选择 | 理由 |
|---|---|
| 两个刻度：`tMs` 相对原点、`atMs` 绝对墙钟 | 正文只展示 `tMs`（节奏诊断）；`atMs` 放 `title` 悬停，用于跨会话比对 |
| 原点显式钉在 `beginRunSession`（= 用户按下运行那一刻） | 不能靠首行惰性兜底：校验失败的会话只有一行、且会与上一轮残留共用基线 |
| 单位与精度恒定（只用秒、固定两位小数） | 竖排时小数点对齐才好比对；按时长切精度会在 59.99s/60.0s 边界突然少一位 |
| `seq` 单调序号做列表 `key` | 日志是"尾部追加 + 头部裁剪"，用下标做 key 会在裁剪时 DOM 与内容错位 |
| 相对时间用**到达时刻**近似产生时刻 | 通道不攒批（§6.6 实测十条节拍精确 1000ms 到达）；若真发生整段缓冲，UI 早已肉眼可见地卡死 |
| 一处时基（渲染侧），不让主进程各自打戳 | 混用两个原点后行与行不再可比 —— 而"行与行的差"是这套刻度唯一要回答的问题 |

**渲染侧**（`RuntimeView.vue`）：标签是独立的 `.rl-t` 列（定宽 + `tabular-nums`），
正文 `.rl-x` 左边缘对齐成一列；可见窗口由 30 行放宽到 **80 行** —— 窗口太窄时
一段带告警的构建输出就能把 `[running]` 挤出可视区，恰好弄丢要对比的那半截。

**实测（真实 UI、真实点击「实时运行」、REALTIME、`stopSeconds=10`）**：

```
   +0.00s  ▶ 开始运行：___P2P__UDP · REALTIME
   +0.09s  [connecting] 已订阅浏览器事件流
   +0.62s  [uploading] …/scratch/___P2P__UDP.cc
   +0.88s  [building] ___P2P__UDP
   +1.19s  [1/2] Building CXX object …            ← 这次是 ccache 命中；首编时此处在 +4.5s
   +1.64s  [2/2] Linking CXX executable …
   +1.66s  [running] ___P2P__UDP · REALTIME
  +12.01s  [done] 退出码 0 · 12.0s
  +12.04s  ✓ 运行完成 · 12.0s
```

`[done] − [running] = 10350 ms` —— **不需要任何外部基线，减法就是运行阶段的墙钟耗时**，
且顺带把聚合耗时 `12.0s` 分解成了"构建 1.66s + 运行 10.35s"。
（同一产物首编那次：`[running] @+5.05s`、`[done] @+15.41s`，差值 10366 ms —— 两次一致。）

验证方式（两层证据，缺一不可）：`C:/tmp/ns3-run/runlog-ui-probe.mjs`
—— ① store 层：`rt.simLog` 每行都有 `tMs/atMs`、`seq` 单调；
② **DOM 层**：`.rl-list li` 里真的渲染出了 `.rl-t` 标签、且逐行与 store 一致、`title` 带绝对时刻。
只验①会漏掉"数据对、界面没渲染"。

**回归**：`test/runLog.test.ts`（17 用例：格式/打戳/过滤/裁剪/诊断契约），
`test/runtimeStore.test.ts` 增 3 用例（含"新会话重钉原点"）。
两刀变异验证均精确变红：把 `tMs` 改成恒 0 → 6 处红；把噪声正则只留 `[EPC-OP]` → 3 处红。
噪声过滤另有一条**同源**断言（`RUN_LOG_NOISE` 必须命中 `EPC_PREFIX` 的每个前缀），
防止将来改遥测协议前缀时过滤**静默失效**、导致遥测刷屏淹掉编译错误。

---

## 6.9 运行模式的唯一来源：工程的运行设置（ProjectConfig.run）

> 触发：同一份日志里会话首行写着 `· REALTIME`、阶段行却写着 `[running] · OFFLINE`。
> 要求的不是"修掉这一行字"，而是**全项目统一、不留补丁**。

### 之前：模式有五个来源

| 来源 | 位置 | 问题 |
|---|---|---|
| 工程文件 | `project.hil.mode` | 模式属于"运行"，却寄生在 HIL 段里 |
| 内存态 | renderer store 顶层 `wb.run` | 真正被跑的那个，但不随工程保存，切个工程就漂 |
| 默认值 | `generate()` 的默认入参 | 漏传时不报错， silently 变 OFFLINE |
| 按钮改写 | Runtime「实时运行」事前写 run | 与上面那份靠"发车前抄一遍"维持一致 |
| **通道推导** | `serverMonitor.cjs` 的三值白名单 | 把 REALTIME 静默塌成 OFFLINE；且该进程有模块缓存，改源码不重启不生效 |

任何一条路径漏抄，界面上就出现两个互相打架的模式，而用户无从分辨哪个是真的。

### 现在：唯一来源是 `project.run`（RunConfig，随工程保存与切换）

- `ProjectConfig.run` 为**必填**字段（模式 / 时钟源 / 步长类型 / 停止秒数 / 同步模式）；
  `hil` 只留引擎参数（`timestepUs` / `simulatorAddr`）。
- 删除 store 级 `run`、删除消费端清洗模式名的 `phaseDetail()` 补丁 —— 没有第二个真值，也就无需补丁。
- **通道不推导**：`p.mode` 原样透传；且**阶段行的 detail 不含模式名**（只报 `[phase] {detail}`）。
  理由写在代码注释里：该模块跑在独立进程、加载进程内缓存副本，任何自猜迟早与渲染端漂移。
- 生成器取自 run：`const run = config.run ?? DEFAULT_RUN`（不再回头读 hil）。
- `SIM_MODES` 补入 REALTIME（此前存 REALTIME 的工程重开会静默变 OFFLINE）；
  旧工程 `hil.mode` 在解析时迁移到 `run`。

### 界面一致性：每一处模式选择器必须给全三值

`ConfigView` 的「HIL/时钟源」原先只列 `离线 / HIL 闭环` —— 工程里若存着 REALTIME，
radio 组匹配不上任何一项、**一个都不选**，看着像"没设模式"，实际藏着个界面看不见的值。
已补齐 `实时`，并由架构守卫锁住（见下）。

### 三层守护

1. **静态守卫** `test/runMode.test.ts`：源码扫描（注释会被剥掉，避免误报）——
   无第二份 run、无 `hil.mode` 读写、无 `project.hil = {…}` 拷贝、生成器取自 run、
   通道不推导且阶段行不复述模式、**每处模式选择器覆盖三值全集**。
   *为什么用文本扫描而不是只靠类型编译器*：`electron/serverMonitor.cjs` 不在 tsc 视野里，
   而它恰恰是最危险的那个泄漏点。
2. **端到端守护** `runtimeStore.test.ts`：stub 通道跑真 `runSim`，三模式逐个断言
   「会话首行 = payload.mode = 产物代码」；
   产物侧判据用 emitted code（`RealtimeSimulatorImpl` / `TapBridgeHelper tapBridge`），
   不用字面量 `TapBridge`（后者也出现在 OFFLINE 的说明注释里，会误判）。
3. **真 UI 复验**：见下方验证结果，UI 上点出来的模式必须与实际跑的一致。

### 验证结果（真 UI，一次成型）

载入内置案例「案例_P2P主从UDP」（自带 OFFLINE）→ 配置页点「实时」→ `project.run.mode = REALTIME`
→ Runtime 页点「实时运行」：

```
0a 载入的工程名: 案例_P2P主从UDP        0b 案例自带的运行模式: OFFLINE
1b 配置页-模式选项: 离线/实时/HIL 闭环   1c 点「实时」后 project.run.mode: REALTIME
2b simPhase / simMode / exit: done / REALTIME / 0
2c 日志首行: ▶ 开始运行：___P2P__UDP · REALTIME
2e DOM 里带 .rl-t 的行数: 16 / 日志总数 16     2f 出现 OFFLINE 的行: (无)
2g 首行→终行: 11961 ms   ← 10s 实时仿真 + 构建
```

对照实验：不载入案例、直接跑默认空工程 `Untitled` → 编译通过但运行 `exit=250`（空拓扑所致，非本次改动）。

**回归**：`vitest 228/228（15 文件）· vue-tsc 0 · vite build 0`。
**变异验证 5 刀全部精确变红**（加回 `store.run` / `cfg.hil?.mode` / 生成器读 hil / 通道白名单 /
`mode` 写死 `'OFFLINE'`），还原后全绿、文件逐字校验（`diff -q`）确认无残留。

### 踩坑：vitest 可能给出陈旧结果

全量跑报"ConfigView 缺 REALTIME"，而文件三值齐全、单文件跑也绿 —— `vitest run --no-cache` 即全绿。
**源码扫描类测试遇到"文件对但断言红"，先 `--no-cache` 复跑再怀疑代码。**
另：数组断言的失败 diff 会被截短成 `Array(1)`，看不到是哪个文件缺哪一项，
应把 offenders `join(' | ')` 拼进字符串再断言。


## 6.10 Runtime 运行结果的「环境适配层」：浏览器不再弹「未处于 Electron 环境」

### 病灶：视图层裸判 `window.epcomhil`

`RuntimeView.vue` 的「保存结果 / 历史结果」直接 `const api = window.epcomhil; if (!api) return ElMessage.warning('未处于 Electron 环境…')`。
浏览器下必然弹框 —— 但这不是"浏览器不支持"，而是**该走的适配层没走**：工程存取（`utils/projectStorage.ts`）、
案例库（`utils/sceneLibrary.ts`）**都**有「Electron 原生对话框 / 浏览器 Blob 下载 + `<input type=file>`」的降级，唯独 runtime 结果这条漏了。

### 澄清：Electron 侧一直是好的

用与 `main.cjs` 同款 `webPreferences` 起无头 Electron 探针实测：`window.epcomhil` 注入成功，
`saveRuntimeResult` / `openRuntimeResult` 均为函数（`preload.cjs` 暴露项与 `main.cjs` 的 IPC 处理器一一对应）。
所谓"Electron 也不支持"，实际是在**浏览器预览面板**里点的 —— 该面板无 Electron 壳，凡走 IPC 的功能都会弹此提示。

### 修法

| 层 | 改动 |
|---|---|
| `utils/runtimeResultStorage.ts`（新） | 对称 `projectStorage.ts`：`saveRuntimeResultText()` / `openRuntimeResultText()` / `suggestRuntimeResultName()` / `isElectronShell()`；返回 `via: 'electron' \| 'download' \| 'file'` 供文案区分 |
| `RuntimeView.vue` | 两个处理器改走适配层；删掉裸判与旧提示；保存成功按 `via` 显示「已保存」/「已下载」 |

顺带修一处真 bug：文件名出现过 `Untitled_20260921075730..runtime.json` **双点** ——
`toISOString().replace(/[-:T]/g,'')` 未去掉毫秒前的 `.`，`slice(0,15)` 正好把它截进来。
文件命名收进 `suggestRuntimeResultName()`，时间戳改 `replace(/\D/g,'').slice(0,14)`（只取数字）。

### 守护与验证

- `test/runtimeResultStorage.test.ts`（8 例）：Electron 通道 / 浏览器下载 / 文件选择 / 取消 / **文件名双点回归** / 非法字符 / 空工程名。
- **变异验证**：去掉浏览器降级 → 恰好 3 条浏览器路径用例变红，Electron 用例仍绿；还原后全绿。
- **真实浏览器 CDP**：点「历史结果」→ 建出 `<input type=file accept=".json,application/json">`；
  点「保存结果」→ 触发下载 `Untitled_20260921080009.runtime.json`（单点）；**全程无「未处于 Electron 环境」**。
- 回归 `vitest 236/236（16 文件）· vue-tsc 0 · vite build 0`。

### 纪律

**依赖 Electron IPC 的能力一律走 `utils/` 适配层，视图内禁止裸判 `window.epcomhil`。**
headless 下 file chooser 弹不出来（无 user activation）→ 验证"直通文件选择"用**反向断言**（拦 `HTMLInputElement.prototype.click` 看有没有建 file input）。

## 6.11 运行结果写入「工程所在文件夹」+ Runtime 页 Ctrl+S

### 需求纠正

上一轮把浏览器降级成「保存=下载」是对的，但**Electron 侧的语义错了**：用户要的是
「保存结果 = 写进工程所在文件夹」，而不是弹对话框/下载。并且要在 Runtime 界面提供 **Ctrl+S** 保存。

### 设计：主进程记住「工程文件夹」，结果文件静默落盘

| 层 | 改动 |
|---|---|
| `electron/main.cjs` | 新增模块级 `currentProjectDir`；`project:save` / `project:saveDirect` / `project:open` 三处**确立**它；新增三个 IPC：`runtime:saveResultInProject`（静默写入，不弹框）、`runtime:listResults`（列目录内 `*.runtime.json`，按 mtime 倒序）、`runtime:readResult`（按名读取） |
| `electron/preload.cjs` | 暴露 `saveRuntimeResultInProject` / `listRuntimeResults` / `readRuntimeResult` |
| `utils/projectStorage.ts` | 新增 `setProjectDirFromPath` / `getCurrentProjectDir` / `clearProjectDir`（渲染侧镜像，仅用于 UI 判断）；`saveProjectText` 加 `forceDialog` 选项；`saveProjectText`/`openProjectText` 成功后确立目录 |
| `utils/runtimeResultStorage.ts` | 新增 `saveRuntimeResultToProject` / `listRuntimeResults` / `readRuntimeResultByName`；`via: 'project' \| 'download'` 区分两态 |
| `TopologyView.vue` | 另存为/打开→确立目录；新建/内置案例/用户案例→清空目录 |
| `RuntimeView.vue` | `onSaveResult` 走工程文件夹（无目录时先弹确认引导存工程）；`onOpenResult` 优先弹**历史结果列表对话框**，无目录则退回单文件选择；`onMounted` 绑 **Ctrl+S**（`preventDefault`）→ 保存结果 |

安全：`runtime:saveResultInProject` / `runtime:readResult` 只接受**单段文件名**（`^[^\\/]+$` 且不含 `..`），
写入前再 `path.join` 校验一次，防路径穿越。

### 修掉的一个真 bug（变量遮蔽）

`ipcMain.handle('project:saveDirect', (_e, { path, content }) => ...)` 里 `const { path } = payload`
**遮蔽了模块级 `require('node:path')`**，导致 `path.dirname(path)` 抛 `path.dirname is not a function`，
工程文件夹永远确立不了 → 结果文件永远 `no-project-dir`。
**真实 Electron 探针实测抓到**，改为 `const { path: filePath } = payload`。

### 守护与验证

- `test/projectStorage.test.ts`（5 例）：路径切分/清空/状态机。
- `test/runtimeResultStorage.test.ts`（14 例）：新增工程文件夹三函数 + `via` 两态。
- `scripts/test-ipc-regression.cjs` + `test/ipcRegressionRunner.test.ts`：**纯 node 覆盖 `Module._load` 注入假 electron**，
  直接调用真实 `main.cjs` 的 IPC 处理器（`electron` 被 vitest externalize，`vi.mock` 拦不住，故走子进程）。
  > 坑：`vi.mock('electron')` 对 node_modules 包默认不生效（被 externalize）；`server.deps.inline` 也未奏效 →
  > 用子进程 node 脚本覆盖 `Module._load` 是可靠解。
- **真实 Electron 探针**（`require('../electron/main.cjs')` 注册全部 handler）：`saveProjectDirect` 确立目录 →
  `saveRuntimeResultInProject` 写入 → `listResults` 列出 → `readResult` 读回 → 穿越被拒；磁盘确认文件落地。
- **真实浏览器 CDP（14 项全绿）**：载入内置案例→离线运行→「保存结果」触发下载（1 次、单点文件名）+
  提示「已下载」；「历史结果」建出 `<input type=file>`（1 个）+ 提示「尚未保存到本地」；Ctrl+S 下载计数 +1；
  **全程无「未处于 Electron 环境」**。
  > 坑：`Page.navigate` 到**同源同文档的 hash**（`#/a` → `#/b`）**不换 JS 上下文**，插桩会叠加 → 一次点击记 2 次。
  > 插桩只在最终上下文做一次，或用 cache-bust 查询强制全新文档。
- 回归 `vitest 252/252（18 文件）· vue-tsc 0 · vite build 0`。
