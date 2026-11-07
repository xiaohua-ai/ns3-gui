const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, LevelFormat, HeadingLevel, BorderStyle, WidthType,
  ShadingType, VerticalAlign,
} = require("docx");

const CJK = "Microsoft YaHei";
const FONT = { ascii: "Arial", hAnsi: "Arial", eastAsia: CJK };

// ---------- 构建块 ----------
const H1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(t)] });
const H2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });

const P = (t) => new Paragraph({ children: [new TextRun(t)], spacing: { after: 120 } });

// 加粗文本段
const PB = (parts) => new Paragraph({ children: parts.map(p => new TextRun({ text: p.t, bold: p.b || false })), spacing: { after: 120 } });

// 引用式说明行
const node = (t) => new Paragraph({ children: [new TextRun({ text: t, italics: true, color: "595959" })], spacing: { after: 120 } });

// 列表
const bullets = ["bullets"];
const bullet = (t, level = 0) => new Paragraph({ numbering: { reference: "bullets", level }, children: [new TextRun(t)], spacing: { after: 60 } });
const nums = ["numbers"];
const numItem = (t) => new Paragraph({ numbering: { reference: "numbers", level: 0 }, children: [new TextRun(t)], spacing: { after: 60 } });

// 代码块/架构图：等宽字体，浅灰底，保留空格
function codeBlock(lines) {
  return lines.map(line =>
    new Paragraph({
      spacing: { after: 0 },
      shading: { fill: "F2F2F2", type: ShadingType.CLEAR },
      children: [new TextRun({ text: line.replace(/ /g, "\u00A0"), font: { ascii: "Consolas", hAnsi: "Consolas", eastAsia: "Microsoft YaHei" }, size: 18 })],
    })
  );
}

const border = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const borders = { top: border, bottom: border, left: border, right: border };

function table(headers, rows, widths) {
  const total = widths.reduce((a, b) => a + b, 0);
  const mkCell = (text, w, opts = {}) =>
    new TableCell({
      width: { size: w, type: WidthType.DXA },
      borders,
      shading: opts.head ? { fill: "D5E8F0", type: ShadingType.CLEAR } : undefined,
      verticalAlign: VerticalAlign.CENTER,
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({ children: [new TextRun({ text, bold: opts.head || false })] })],
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: widths,
    rows: [
      new TableRow({ cantSplit: true, tableHeader: true, children: headers.map((h, i) => mkCell(h, widths[i], { head: true })) }),
      ...rows.map(r => new TableRow({ cantSplit: true, children: r.map((c, i) => mkCell(c, widths[i])) })),
    ],
  });
}

const spacer = (t = "　") => new Paragraph({ children: [new TextRun({ text: t, color: "FFFFFF" })] });

// ---------- 内容 ----------
const children = [];

children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 120, after: 360 },
  children: [new TextRun({ text: "电力通信融合硬件在环仿真平台", bold: true, size: 44 })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 480 },
  children: [new TextRun({ text: "架构设计说明书", bold: true, size: 44 })],
}));

// ================= 一、平台定位 =================
children.push(H1("一、平台定位"));
children.push(H2("1.1 核心定义"));
children.push(new Paragraph({
  spacing: { after: 120 },
  children: [
    new TextRun({ text: "本平台是一套" }),
    new TextRun({ text: "面向源网荷储、配电网场景的电力通信融合硬件在环（HIL）仿真平台", bold: true }),
    new TextRun({ text: "，以 ns-3 为通信仿真内核，通过标准化接口对接第三方电力实时仿真器，支持虚拟电力终端与真实物理终端混合组网，实现「电力物理仿真 + 通信网络传输 + 半实物终端接入」三者闭环的实时联合仿真，为电力通信性能验证、保护测控闭环测试、网络故障影响分析、终端接入验证提供全场景仿真能力。" }),
  ],
}));

children.push(H2("1.2 能力边界"));
children.push(PB([{ t: "平台核心承担", b: true }]));
children.push(bullet("全通信网络仿真：拓扑建模、协议栈模拟、网络故障注入、性能指标计算"));
children.push(bullet("HIL 联合仿真调度：多系统时间同步、数据交互调度、闭环流程管控"));
children.push(bullet("电力终端建模：内置光伏、储能、负荷、IED、RTU 等自定义节点的通信层与业务行为模型"));
children.push(bullet("半实物终端接入：真实物理终端经 Linux 端单一物理网口汇聚接入虚拟网络，虚拟网卡分配与节点映射由上位机统一配置，与虚拟节点混合组网"));
children.push(bullet("全场景可视化：拓扑拖拽建模、实时状态监控、性能曲线展示、报文级回放"));
children.push(spacer());
children.push(PB([{ t: "平台明确不承担", b: true }]));
children.push(bullet("电力系统电磁暂态 / 机电暂态数值计算（由 RTDS/ADPSS 等专业电力仿真器原生承担）"));
children.push(bullet("电力一次设备的物理特性仿真"));
children.push(bullet("电力仿真器内部模型的编辑与维护"));

children.push(H2("1.3 典型应用场景"));
children.push(bullet("源网荷储通信网络性能验证与故障注入测试"));
children.push(bullet("配网保护测控装置通信闭环 HIL 测试"));
children.push(bullet("光伏 / 储能逆变器、智能终端的半实物接入验证"));
children.push(bullet("电力通信网络故障对电力系统控制稳定性影响分析"));
children.push(bullet("电力专用协议（IEC 61850、Modbus）传输特性测试"));

// ================= 二、整体架构体系 =================
children.push(H1("二、整体架构体系"));
children.push(H2("2.1 逻辑架构（四层解耦）"));
children.push(P("采用分层解耦设计，在原有纯通信架构基础上扩展电力对接、HIL 调度、半实物接入能力，层间通过标准化接口交互，任意层升级不影响整体架构。"));
children.push(...codeBlock([
  "┌───────────────────────────────────────────────────────────┐",
  "│          交互呈现层（Windows 前端，Web 化呈现）              │",
  "│  电力通信拓扑建模 · HIL/工况配置 · 实时状态监控 · 结果可视化     │",
  "├───────────────────────────────────────────────────────────┤",
  "│          跨端接口层（标准化契约，前后端解耦）                  │",
  "│    拓扑数据规范 · HIL 配置规范 · 指标格式 · gRPC 服务接口      │",
  "├───────────────────────────────────────────────────────────┤",
  "│          仿真服务层（Linux 后端，核心业务编排）                │",
  "│  工程管理 · 代码生成 · 双模式调度 · HIL 同步 · 故障注入        │",
  "│  电力协议适配 · 电力节点模型库 · 半实物接入管理 · 指标采集       │",
  "├───────────────────────────────────────────────────────────┤",
  "│          内核与外部对接层（能力底座 + 外部系统）                │",
  "│  ns-3 通信内核 · 电力仿真器对接层 · 半实物网络适配层            │",
  "└───────────────────────────────────────────────────────────┘",
]));
children.push(spacer());
children.push(node("统一口径：交互呈现层统一采用 Web 化技术栈（Electron 外壳 + Vue 3 前端 + AntV X6 / ECharts 可视化组件，gRPC 经 Electron 主进程 Node 侧直连），避免再引入 C++ 原生 GUI 方案，详见 3.1 节；该口径贯穿 2.1 逻辑架构、2.2 部署架构与本层所有模块说明，保持一致。"));

children.push(PB([{ t: "（1）交互呈现层（Windows 端）", b: true }]));
children.push(node("定位：纯人机交互入口，无实时计算、无硬件对接、无电力仿真逻辑，仅负责输入配置与输出展示。"));
children.push(bullet("场景与工况库模块：内置 Simple / Complex 典型工况与自定义工程浏览，支持说明预览、工况 JSON 加载与一键运行"));
  children.push(bullet("拓扑建模模块：组件库包含通用通信设备 + 电力终端节点（光伏、储能、IED、RTU 等），支持拖拽式组网、链路连接、属性编辑"));
children.push(bullet("工况配置模块：仿真模式切换（离线 / HIL）、时钟源选择（PTP 精密时钟 / 内置时钟）、网络故障配置、HIL 对接参数配置、半实物接入配置（虚拟网卡分配与节点一一映射、单一物理网口汇聚）"));
children.push(bullet("状态监控模块：仿真进度、时间同步状态、链路状态、节点在线状态、电力数据流向可视化"));
children.push(bullet("结果展示模块：通信性能曲线、报文回放、数据导出、闭环测试报告生成"));
children.push(bullet("工程管理模块：拓扑、配置、结果的一体化工程存储与多工况管理"));

children.push(PB([{ t: "（2）跨端接口层", b: true }]));
children.push(node("定位：前后端交互的唯一标准化契约，保证两端独立演进。"));
children.push(bullet("统一 gRPC 服务接口，覆盖工程管理、仿真控制、数据订阅、HIL 配置四大类"));
children.push(bullet("标准化拓扑数据模型：扩展电力节点类型、电力协议参数、半实物映射配置"));
children.push(bullet("流式数据接口规范：实时指标、运行日志、同步状态的低延迟推送"));

children.push(PB([{ t: "（3）仿真服务层（Linux 端）", b: true }]));
children.push(node("定位：仿真业务核心编排层，承接前端请求，调度内核与外部系统完成闭环仿真。"));
children.push(bullet("工程管理模块：工程文件存储、版本管理、编译产物隔离"));
children.push(bullet("代码生成模块：基于拓扑数据与模板引擎，自动生成 ns-3 仿真源码"));
children.push(bullet("双模式调度模块：离线离散事件仿真 / HIL 实时仿真双模式无缝切换"));
children.push(bullet("HIL 同步引擎：负责与电力仿真器的时间同步、步进调度、数据交互管控"));
children.push(bullet("故障注入引擎：插件化实现通信层故障，支持时间触发与条件触发"));
children.push(bullet("电力节点模型库：内置光伏、储能、负荷、IED、RTU 等终端的通信层与业务行为模型"));
children.push(bullet("电力协议适配模块：IEC 61850、Modbus 等电力专用协议的解析与报文生成"));
children.push(bullet("半实物接入管理模块：承接上位机下发的半实物接入配置，负责 Tap 虚拟网卡落地、节点绑定、物理网口汇聚与虚实网络桥接"));
children.push(bullet("指标采集模块：通信指标、同步状态、业务数据的采集、预处理与推送"));

children.push(PB([{ t: "（4）内核与外部对接层", b: true }]));
children.push(node("定位：底层能力底座与外部系统的适配层，向上提供统一能力，向下对接异构系统。"));
children.push(bullet("ns-3 原生通信内核：高精度离散事件调度、完整 TCP/IP 协议栈、多类型信道模型"));
children.push(bullet("电力仿真器对接层：对接 RTDS/ADPSS/RTLab 等电力实时仿真器，实现数据交互与时间同步"));
children.push(bullet("半实物网络适配层：基于物理网卡与虚拟网桥，实现真实终端与虚拟网络的双向数据透传"));

children.push(H2("2.2 部署架构（三网分离，四实体）"));
children.push(P("采用控制面、数据面、实物面三网分离的部署架构，保障实时性与稳定性，符合工业级 HIL 部署规范。"));
children.push(...codeBlock([
  "┌─────────────┐",
  "│ Windows上位机 │──────控制网（TCP/gRPC）──────┐",
  "└─────────────┘                              ▼",
  "                                  ┌──────────────────┐",
  "                                  │  Linux仿真服务器  │",
  "                                  │  （ns-3 + HIL）  │",
  "                                  └─────────┬────────┘",
  "                                            │",
  "                          ┌─────────────────┴─────────────────┐",
  "                          ▼                                   ▼",
  "                  ┌──────────────┐                    ┌──────────────┐",
  "                  │ 电力实时仿真器 │────实时数据网─────┤  半实物终端  │",
  "                  │ (RTDS/ADPSS) │                    │ (光伏/IED等) │",
  "                  └──────────────┘                    └──────────────┘",
]));
children.push(spacer());
children.push(bullet("控制网：Windows 上位机与 Linux 仿真服务器之间的办公网络，传输拓扑配置、控制指令（gRPC）与监控 / 可视化数据（gRPC 流 / WebSocket），实现跨机跨平台「上位机 ↔ ns-3 仿真服务」交互（详见 5.10），无实时性要求"));
children.push(bullet("实时数据网：Linux 仿真服务器与电力实时仿真器之间的专用局域网，传输时间同步信号、量测 / 控制数据，要求低抖动、高可靠"));
children.push(bullet("实物接入网：Linux 仿真服务器与半实物终端之间的物理网络，服务器物理端仅配置单一真实网口汇聚承载全部半实物终端流量；虚拟网卡分配与节点映射在上位机侧统一配置后下发"));

children.push(H2("2.3 核心闭环数据流"));
children.push(P("HIL 模式下的完整数据闭环，全程由 Linux 端调度，Windows 端仅做状态展示："));
children.push(numItem("电力仿真器推进到当前时刻，输出一次设备量测数据"));
children.push(numItem("数据通过实时数据网进入 Linux 仿真端，映射为对应通信节点的输入报文"));
children.push(numItem("ns-3 通信内核完成报文传输、时延、丢包、排队等全通信过程模拟"));
children.push(numItem("报文到达目标终端节点（虚拟节点或半实物真实终端），解析生成控制指令"));
children.push(numItem("控制指令沿通信链路回传，经过网络传输后输出至电力仿真器"));
children.push(numItem("电力仿真器接收控制指令，推进到下一个仿真步长，完成一次闭环步进"));

// ================= 三、技术栈体系 =================
children.push(H1("三、技术栈体系"));
children.push(P("后端与通信内核以 C/C++ 为核心，保障实时性与高性能；Windows 交互呈现层采用 Web 技术栈，兼顾可视化友好、界面美观与快速迭代，并新增电力协议、HIL 对接、半实物接入相关技术组件。"));

children.push(H2("3.1 Windows 前端技术栈（Web 化呈现层）"));
children.push(P("应用外壳采用成熟桌面方案 Electron，前端全 Web 技术，托拉拽拓扑与实时曲线均由成熟 Web 图表库承载，显著提升可视化友好度与界面表现力，并为电力仿真器等原生能力预留 Node 侧集成通道。"));
children.push(table(
  ["技术组件", "选型", "选型说明"],
  [
    ["应用外壳", "Electron（Chromium + Node.js）", "生态最成熟、跨平台渲染一致的桌面外壳，Node 侧能力接入原生组件方便，商业软件验证充分"],
    ["前端框架", "Vue 3 + TypeScript + Vite", "响应式组件化开发，生态成熟、构建快，支撑拓扑画布与监控界面的模块化迭代"],
    ["拓扑建模", "AntV X6", "专为工业 / 网络拓扑设计，支持拖拽组网、自定义电力/通信节点、链路连接与缩放平移"],
    ["性能曲线", "ECharts", "高性能图表库，实时性能曲线、区间缩放、数据下钻，中文文档友好"],
    ["状态监控", "Vue 组件 + WebSocket/流式订阅", "前端订阅后端 gRPC 流式接口，低延迟刷新仿真进度、同步状态与节点在线状态"],
    ["通信交互", "gRPC + Electron 主进程（Node）", "Electron 主进程 Node 侧直连后端 gRPC 服务，前端经 IPC 转发；亦兼容 gRPC-Web（connect）规范，适配流式数据推送"],
    ["JSON/数据", "TypeScript + 原生 JSON 序列化", "拓扑与配置数据以标准 JSON 承载，两端一致性由跨端接口层契约保证"],
    ["路由/状态管理", "Vue Router + Pinia", "多级流程式页面导航 + 全局仿真状态集中管理，支撑配置→运行→分析流程化跳转"],
    ["实时数据通道", "WebSocket + gRPC 流式订阅", "低延迟推送 Linux 端采集的指标与同步状态，替代共享内存实现采集/渲染解耦"],
    ["界面组件库", "Element Plus（深色工业主题）", "成熟组件库 + CSS 变量统一主题，兼顾信息密度与工业风质感"],
    ["结果导出", "ECharts 图片 + CSV 导出", "图表/数据一键导出，支撑闭环测试报告自动生成"],
    ["报文回放（3D 细查）", "NetSimulyzer 外置调用", "独立进程调用的 3D 报文级离线回放，作为主界面 2D 结果面板的可选细查手段，二者共存且职责分工"],
  ],
  [1800, 3200, 5400]
));
children.push(node("说明：采用 Web 呈现层的核心收益是可视化友好度——拓扑建模、实时曲线、配置界面均可用成熟 Web 生态实现，界面质感与交互体验远优于 C++ 原生控件；选型 Electron 取其生态成熟、跨平台渲染一致、Node 侧集成原生能力便捷，安装包与内存占用稍高的代价在本上位机场景下可接受。"));

children.push(H2("3.2 Linux 后端技术栈"));
children.push(table(
  ["技术模块", "选型", "选型说明"],
  [
    ["服务框架", "gRPC C++ 服务端", "高性能 RPC 框架，支持流式响应，适配控制与数据推送"],
    ["代码生成", "C++ 字符串模板引擎", "外置模板文件，新增节点 / 协议仅需新增模板，无需重编译"],
    ["编译系统", "ns-3 CMake 构建（3.36 起默认，采用 ns-3.46 稳定版）", "以官方 ns3（CMake 包装工具）构建，不使用旧版 Waf；与最新稳定版对齐保证版本兼容与性能（详见 3.5）"],
    ["仿真调度", "ns-3 原生调度器 + RealTimeSimulator", "离线模式用离散事件调度，HIL 模式切实时调度"],
    ["时间同步", "自定义保守步进同步引擎", "基于 ns-3 外部事件注入机制，实现严格主从同步"],
    ["故障注入", "ns-3 原生 ErrorModel/DelayModel", "内核原生机制，性能开销极低，插件化扩展"],
    ["电力协议", "libiec61850 / libmodbus", "开源工业级 C 协议栈，封装为节点插件，稳定可靠"],
    ["半实物接入", "ns-3 EmuNetDevice + Linux Tap 网桥", "内核原生支持虚实网络桥接，Tap 虚拟网卡分配与节点映射由上位机配置下发落地，单网口汇聚，性能损耗小"],
    ["进程管理", "Systemd + Linux 原生进程隔离", "仿真进程独立沙箱，崩溃不影响主服务"],
  ],
  [1800, 3200, 5400]
));

children.push(H2("3.3 外部对接技术栈"));
children.push(bullet("电力仿真器对接：千兆以太网 + UDP/gRPC 协议，支持自定义实时总线协议适配"));
children.push(bullet("半实物终端接入：Linux 侧单一物理网口（多终端汇聚）+ 二层网桥，Tap 虚拟网卡由上位机配置下发，支持 VLAN 隔离"));
children.push(bullet("时间同步基准：支持兼容 PTP 精密时间协议网卡；HIL 时钟源可在上位机工况配置中选择为「PTP 精密时钟」或「内置独立时钟」并下发，为多设备提供统一时钟基准（详见 4.1）"));

children.push(H2("3.4 核心依赖说明"));
children.push(bullet("通信内核：采用最新稳定版 ns-3.46（原生 C++，官方 CMake 构建系统编译），完整网络模型生态"));
children.push(bullet("电力仿真：兼容 RTDS、ADPSS、RT-Lab 等主流电力实时仿真器，提供标准化对接接口"));
children.push(bullet("电力协议：内置 IEC 61850 MMS/GOOSE、Modbus RTU/TCP 等常用电力协议插件"));

children.push(H2("3.5 ns-3 版本对齐与构建优化计划"));
children.push(P("对比最新稳定版 ns-3（撰写时 3.46）的技术演进，明确平台基于新版本官方 CMake 构建的优化计划，彻底弃用旧版 Waf 产线。"));
children.push(bullet("构建系统对齐：自 ns-3.36 起官方默认 CMake，平台统一以官方 ns3（CMake 包装工具）构建与运行脚本，不建立任何 Waf 构建路径"));
children.push(bullet("版本基线：锁定 ns-3.46 稳定版（前置要求 g++-10.1+ / clang++-11+、Python 3.8+、CMake），跟随官方发布节奏评估升级（约每半年一版）"));
children.push(bullet("实时性能优化：以 optimized build profile（-O3 + NDEBUG，关闭断言与检查）编译，降低单事件开销，配合 4.1 步长内算力预算保障 HIL 实时吞吐"));
children.push(bullet("按需编译裁剪：构建时仅启用平台所需模块（core / network / internet / wifi / point-to-point / csma / buildings 等），缩减构建产物与交付体积"));
children.push(bullet("新特性对齐：3.37 起 Python（cppyy）绑定可用于自动化测试与基线校验；Wi-Fi 模块新特性（如 3.46 静态关联 helper、wraparound 干扰模型）按需求评估采用"));
children.push(bullet("升级与回归：升级 ns-3 版本时先在 CI 回归 CMake 构建 + HIL 时序测试，确认第四章机制与第七章代码生成产物不受 API 演进影响后再合入"));

// ================= 四、核心架构机制 =================
children.push(H1("四、核心架构机制"));

children.push(H2("4.1 HIL 保守时间同步机制（核心）"));
children.push(P("采用主从架构 + 保守步进的同步策略，电力仿真器为主时钟，通信仿真为从时钟，严格保证通信仿真不超前于电力仿真，从根源上避免时序错误。"));
children.push(bullet("主时钟：电力实时仿真器，控制全局仿真步长推进"));
children.push(bullet("从时钟：Linux 端 ns-3 仿真，被动跟随主时钟，绝不超前执行"));
children.push(bullet("步进流程：电力仿真器完成 t 时刻计算 → 发送量测数据与步进指令 → ns-3 注入外部事件并推进到 t 时刻 → 完成通信域计算后返回步进确认 → 电力仿真器推进至 t+Δt"));
children.push(bullet("精度保障：所有外部数据通过 ns-3 原生事件队列注入，禁止多线程直接修改仿真状态；支持微秒级步长，满足电磁暂态仿真的时间精度要求"));
  children.push(bullet("与 PTP 的分工：PTP 精密时间协议仅用于半实物 / 仿真器集群的硬件时钟对齐（墙钟统一），保守步进负责逻辑时序语义；两者分层解耦，即便 PTP 未对齐，ns-3 从时钟“逻辑上不超前于电力仿真”的保守性依然成立"));
children.push(bullet("时钟源可选配置：上位机工况配置选择 HIL 时钟源为「PTP 精密时钟」或「内置独立时钟」，经跨端接口层下发 Linux 端；选择 PTP 时依赖 PTP 网卡提供统一墙钟，未授时 / 未安装 PTP 网卡时自动回退内置时钟并给出告警，两种时钟源下保守步进与故障兜底逻辑均保持一致"));
  children.push(bullet("实时性边界：ns-3 实时调度器（RealTimeSimulatorImpl）为 best-effort 节拍而非硬实时，且核心为单线程，HIL 相位必须引入外部真实时钟做同步判断，不可依赖 Simulator::Now()（其返回最后已调度事件时间而非真实墙钟）"));
  children.push(bullet("步长内算力预留：必须在单个步长 Δt 内完成当前步全部 ns-3 通信域计算，超出即整网超时；设计以保守步进 + 外部时钟校准兜底，并在工况配置中预留算力 / 采样降级选项（精简 PHY、加大步长）"));

children.push(H2("4.2 电力节点模板化映射机制"));
children.push(P("内置光伏、储能、负荷、IED、RTU 等标准化电力终端节点模板，实现「前端建模图标 → 后端通信模型 + 业务行为」的自动映射。"));
children.push(bullet("前端组件库仅展示节点类型与通信参数，电力业务参数在后端模板中封装"));
children.push(bullet("每个节点模板包含：通信端口配置、协议栈类型、报文收发逻辑、业务行为规则"));
children.push(bullet("新增自定义节点仅需新增后端模板文件与前端图标，核心架构无需修改"));
children.push(bullet("支持半实物映射：节点可配置为「虚拟模式」或「实物模式」，实物模式下由上位机为该节点分配对应虚拟网卡并完成一一绑定"));

children.push(H2("4.3 半实物终端网络接入机制"));
children.push(P("基于「虚拟网卡 + 二层网桥」实现真实终端与虚拟网络的透明接入，虚实节点在网络层无差异；虚拟网卡资源的分配与节点映射统一由 Windows 上位机规划配置，Linux 物理端仅以单一真实网口汇聚承载全部半实物链路。"));
children.push(bullet("虚拟网卡上位机化管理：Windows 端提供「半实物接入配置」界面，为每个半实物终端分配独立 Tap（EmuNetDevice）虚拟网卡，并显式绑定至虚拟拓扑中对应的仿真节点，配置经跨端接口层下发生效"));
children.push(bullet("单一物理网口共享汇聚：Linux 物理端仅部署 1 个真实网口，无论多少半实物终端接入，所有实物流量均经该网口汇聚承载，虚拟网卡与网段在上位机侧按终端统一分配"));
children.push(bullet("虚拟网卡与节点一一映射：每个 Tap 虚拟网卡显式映射到仿真模型内的指定节点，实现多终端经单网口接入时的一对一精准关联，从配置层面规避虚实端口误配"));
children.push(bullet("真实终端经物理网卡汇聚至服务器专用网口，通过网桥与各 Tap 虚拟网卡二层透传，虚实节点在网络层无差异"));
children.push(bullet("支持真实 MAC/IP 地址映射，真实终端无需修改配置即可接入虚拟拓扑"));
children.push(bullet("支持多终端同时接入，按 VLAN 隔离不同业务网段"));
children.push(bullet("实现注意：TapBridge / EmuNetDevice 接入真实网卡时网卡进入混杂（promiscuous）模式，单物理口承载多终端跨口转发依赖网桥按 MAC 过滤及 bridge 传统/emu 模式选择；实现时须显式配置 MAC 过滤 + VLAN 划分，避免终端间串扰"));
children.push(P("该机制将虚拟网络资源编排上移至交互呈现层，Linux 端仅做承载与转发，使半实物接入完全由上位机可视化管控，属于面向「单网口多终端」场景的架构优化要点。"));

children.push(H2("4.4 双模式兼容机制"));
children.push(P("同一套拓扑模型与工程文件，支持离线仿真与 HIL 实时仿真一键切换，无需重复建模。"));
children.push(bullet("离线模式：ns-3 以最快速度运行离散事件仿真，适合批量工况验证、性能统计"));
children.push(bullet("HIL 模式：切换至实时调度器，对接电力仿真器与半实物终端，实现闭环运行"));
children.push(bullet("模式切换仅修改调度器配置，节点模型、链路配置、故障设置全部复用"));

children.push(H2("4.5 插件化扩展机制"));
children.push(P("所有扩展能力均遵循统一插件接口规范，核心框架稳定不变。"));
children.push(bullet("节点插件：新增电力终端类型、通信设备类型"));
children.push(bullet("协议插件：新增电力专用协议、工业通信协议"));
children.push(bullet("故障插件：新增网络故障类型、网络攻击模式"));
children.push(bullet("对接插件：新增不同品牌电力仿真器的适配驱动"));
children.push(P("上位机应支持为半实物终端配置虚拟网口并映射至仿真模型内部节点；当多个半实物装置通过 Linux 端同一物理网口汇聚接入仿真主机时，应支持为每个半实物终端显式指定其对应的虚拟网卡与仿真节点，实现一对一精准映射，避免虚实端口误配。"));

// ================= 五、交互界面与可视化设计 =================
children.push(H1("五、交互界面与可视化设计"));
children.push(P("本平台交互呈现层深度借鉴国外成熟 ns-3 可视化工具 WiFiViz 的架构实践，并结合本次 Web 化方案与 HIL / 半实物接入诉求进行落地改造。可迁移的设计要点如下：前后端三段解耦（采集→通道→渲染）、JSON 持久化 + 脚本生成中间态、页面栈 + 右侧详情边栏、图表面板体系、采集端采样节流、场景模板库。以下各小节给出本平台的界面设计指导实战。"));

children.push(H2("5.1 界面布局与导航"));
children.push(P("采用「左导航 + 多级页面栈 + 右侧实时详情边栏」的框架布局，对应 WiFiViz 的 QStackedWidget 页面栈与固定侧边栏，Web 化后由 Vue Router 承载多级流程跳转。"));
children.push(bullet("主导航（流程式）：欢迎 / NS-3 环境 → 场景与工况库 → 工程管理 → 拓扑建模 → 工况配置 → 运行监控 → 结果分析，实现配置→运行→分析的流程化跳转与历史返回"));
children.push(bullet("顶栏常驻操作：仿真模式切换（离线 / HIL）、启动 / 停止 / 单步推进、NS-3 路径切换、构建与运行状态指示"));
children.push(bullet("右侧实时详情边栏：随选中对象联动，展示节点 / 链路的实时参数（通信指标、电力数据流向）、半实物终端接入与虚拟网卡映射状态"));
children.push(bullet("深色工业主题：以深色高对比为基调，用 CSS 变量统一配色，突出时间线、曲线与状态色，兼顾长时间监控的画质与信息密度"));

children.push(H2("5.2 配置流程界面"));
children.push(P("借鉴 WiFiViz 的 AP / STA / EDCA / 天线配置页与业务流对话框，形成本平台的电力与通信一体化配置页。"));
children.push(bullet("场景与工况库页：内置 Simple / Complex 工况库并可浏览自定义工程，支持说明预览、加载工况 JSON、一键进入运行或配置"));
children.push(bullet("拓扑建模页：AntV X6 画布 + 组件库（通用通信设备 + 电力终端节点），拖拽组网、链路连接、属性编辑、布局持久化"));
children.push(bullet("节点配置页：承载各电力终端（IED、RTU、光伏、储能等）的通信参数与业务行为，虚拟 / 实物模式切换"));
children.push(bullet("协议配置页：承载 IEC 61850（MMS / GOOSE）、Modbus（RTU / TCP）等电力专用协议参数"));
children.push(bullet("半实物接入配置页：虚拟网卡分配与节点一一映射、单物理网口汇聚、VLAN 划分（对应第四章架构优化）"));
children.push(bullet("HIL / 时钟源配置页：HIL 对接参数（仿真器类型 / 步长 / 同步策略）与时钟源选择（PTP 精密时钟 / 内置时钟），选择 PTP 时显示授时与对准状态，未授时提供内置回退告警（对应 4.1）"));
children.push(bullet("业务报文流配置对话框：以 OnOff / CBR / Bulk 类参数承载电力业务流（定时 / 遥信 / 遥测 / 控制报文）的协议、目标、速率与起止时间"));

children.push(H2("5.3 成果可视化面板体系"));
children.push(P("借鉴 WiFiViz 将时间线、吞吐量、时延、状态占比等拆分为独立图表面板的做法，本平台以 ECharts / AntV X6 实现可插拔结果面板，涵盖通信、电力与 HIL 三类视图。"));
children.push(bullet("通信性能面板：吞吐量、时延（含 CDF）、丢包率、帧组成、节点吞吐量、接收结果"));
children.push(bullet("协议时序面板：报文 / 帧时间线（GOOSE / MMS 逐帧）、调制 / 速率分布、状态占比"));
children.push(bullet("电力数据面板：量测 / 控制数据流向、遥信遥测遥控状态量联动展示"));
children.push(bullet("HIL 同步面板：时间同步状态、步进曲线、主从时钟偏差实时监测"));
children.push(bullet("半实物接入面板：单物理网口下各虚拟网卡 / 节点映射状态、VLAN、终端在线情况"));
children.push(bullet("输出与日志面板：构建、运行、协议报文级日志（类 tcpdump）一次呈现"));

children.push(H2("5.4 实时数据通道与刷新"));
children.push(P("将 WiFiViz「ns-3 trace → Boost 共享内存 → Qt」三段解耦，Web 化替换为「Linux 后端采集 → WebSocket / gRPC 流 → Vue 前端渲染」，保持采集端与渲染端职责分离。"));
children.push(bullet("采集端（Linux）只采集写入，前端只读渲染，杜绝跨线程直接修改仿真状态，与 4.1 保守同步的线程约束一致"));
children.push(bullet("借鉴 precise / rough 采样机制：采集端按采样率产出数据，前端节流渲染，规模增大时通过粗糙采样降低画面开销而不影响统计准确性"));
children.push(bullet("低延迟推送：同步状态、步进、性能指标经流式接口订阅，毫秒级刷新运行监控与 HIL 面板"));
children.push(bullet("支持独立可视化视图：提供仅监控 / 回放的独立窗口，降低主配置页面与高实时渲染的耦合（对应 WiFiViz TimelineOnly 思路）"));
children.push(bullet("统一出口：各类数据经 5.9 仿真输出编排器统一网关推送到前端，前端仅订阅一个接口即消费全部五路事件"));

children.push(H2("5.5 配置持久化与脚本生成工程模式"));
children.push(P("借鉴 WiFiViz 以 JSON 为中间态 + 独立脚本生成器（wifiviz-script-generator）的工程模式，使「配置」与「运行」解耦、场景可复用可版本化。"));
children.push(bullet("JSON 中间态：拓扑、HIL、半实物接入、电力协议配置统一为 JSON，作为「配置 → 脚本 → 运行」的中间文件，支持导出 / 导入 / 复用"));
children.push(bullet("工程化目录：每工况生成带时间戳的工程目录，内含概要 JSON、节点配置、半实物映射、结果数据，支撑多工况回溯（对应 .nsproj 项目文件）"));
children.push(bullet("后端模板引擎生成 ns-3 源码：复用已有代码生成模块，新增节点 / 协议仅需新增模板即可扩展，无需改动核心架构"));
children.push(bullet("对象模型封装代码生成：借鉴 NS3-GUI-HELPER 的 toCode() 多态，让每类节点 / 链路 / 协议对象内聚其 ns-3 生成片段并按类型分派，新增类型仅需新增对象实现（详见 5.8）"));

children.push(H2("5.6 典型工况场景库"));
children.push(P("借鉴 WiFiViz 以目录 + info.md 组织内置场景模板的做法，内置可直接运行的典型工况库，便于演示与二次开发。"));
children.push(bullet("内置 Simple 工况：源网荷储基础组网、单 AP/STA 类最小通信链路"));
children.push(bullet("内置 Complex 工况：配网馈线多 BSS 重叠、隐藏节点类冲突、QoS 混合流量类电力工况"));
children.push(bullet("每个工况含说明与推荐参数元数据，支持一键加载运行；半实物单网口接入样板工程作为专项模板"));

children.push(H2("5.7 与 WiFiViz 的架构借鉴映射"));
children.push(table(
  ["WiFiViz 机制", "本平台落地"],
  [
    ["ns-3 trace → 共享内存 → Qt 查看器", "Linux 采集 → WebSocket / gRPC 流 → Vue 渲染"],
    ["JSON（General / AP / STA）持久化", "拓扑 / HIL / 半实物 / 电力协议 JSON 中间态"],
    ["wifiviz-script-generator 脚本生成", "后端模板引擎自动生成 ns-3 源码"],
    ["页面栈 + 右侧详情边栏", "Vue Router 多级流程页 + 右侧实时详情面板"],
    ["precise / rough 采样节流", "指标采样率 + 前端节流渲染"],
    ["TimelineOnly 独立可视化进程", "独立监控 / 回放视图，降低与主配置页耦合"],
    ["图表面板体系（吞吐 / 时延 / 状态分布等）", "ECharts 可插拔结果面板体系"],
    ["场景模板库 + info.md", "典型工况库 + 说明 / 推荐参数元数据"],
  ],
  [4500, 4800]
));

children.push(H2("5.8 与 NS3-GUI-HELPER 的架构借鉴映射"));
children.push(P("NS3-GUI-HELPER 是一款基于 Java Swing 的 ns-3 拓扑配置器，核心是「配置 → 对象模型 → 代码生成」三段管线。其可迁移点主要补充本平台的拓扑建模与代码生成设计，与 5.7 的 WiFiViz 借鉴互补（前者补配置 / 生成，后者补运行 / 可视化）。"));
children.push(bullet("UI 与生成解耦，共享对象模型：AntV X6 画布只操作画布元素，代码生成只消费统一拓扑对象模型，避免绘制逻辑与生成逻辑混用"));
children.push(bullet("对象自带代码片段、按类型分派：仿 Device / NetworkLink 的 toCode() 多态，每类电力 / 通信节点对象内聚其 ns-3 生成片段，新增类型仅需新增对象实现"));
children.push(bullet("配置对话框统一返回对象：链路 / 网络 / 半实物 / 协议配置对话框一律产出对象，供绘制与生成共享同一数据源，杜绝两套数据模型"));
children.push(bullet("默认参数用户化持久化：仿 forSettings() 将默认链路 / 默认电力协议参数持久化为 JSON，保证界面与生成使用的缺省值一致，便于还原"));
children.push(table(
  ["NS3-GUI-HELPER 机制", "本平台落地"],
  [
    ["配置 → 对象模型 → 代码生成 三段管线", "拓扑对象模型 + 后端模板引擎生成 ns-3 源码"],
    ["对象自带 ns-3 代码片段（toCode / getDeviceConfCode）", "节点 / 链路 / 协议插件封装其 ns-3 生成片段，按类型分派"],
    ["UI（Painter）与生成器解耦，共享 Domain 对象", "AntV X6 画布仅操作画布元素，生成消费统一拓扑模型"],
    ["配置对话框统一返回对象", "链路 / 网络 / 半实物 / 协议配置对话框产出同一数据模型"],
    ["默认配置 JSON 持久化（forSettings）", "默认链路 / 电力协议参数以 JSON 还原界面与生成缺省值"],
  ],
  [4500, 4800]
));

children.push(H2("5.9 仿真输出统一编排机制"));
children.push(P("借鉴 NetSimulyzer 的集中式 Orchestrator 设计，设立统一的「仿真输出编排器」，把通信指标、协议时序（含 GOOSE 二层报文）、HIL 同步状态、半实物接入、运行日志五路事件收敛为一个出口，统一分配事件 ID 与统一时间戳，并按 Header + Events 两段式 JSON 输出。该机制统合 5.3 结果面板、5.4 实时数据通道与 7.7 生成产物，避免多条散落的数据管线。"));
children.push(bullet("集中编排器（OutputOrchestrator）：所有图表 / 节点 / 日志 / 事件在初始化时登记至编排器，由编排器统一分配对象 ID、统一打时间戳并串行输出，杜绝各自为政的数据通道"));
children.push(bullet("Header + Events 两段式文档：Header 段输出静态配置（节点部署、协议参数、坐标轴、色板、拓扑初始），Events 段按时间点输出五路事件——配置与事件分离，一份文档即可完整复现一次运行"));
children.push(bullet("File / Memory 双输出模式：文件模式落盘形成回放存档（支持 6.2 故障现场留存），内存模式由 getJson() 即时取数经 5.4 流式通道推送前端，同一份数据既能存又能推"));
children.push(bullet("播放步进与粒度：设置建议时间步长（Step 与 MS/US/NS 粒度），前端时间轴按步进播放 / 暂停 / 定位断点，支撑报文级回放与 HIL 步进复核"));
children.push(bullet("采样节流：对 Mobility / 高频率通信事件支持按周期轮询采集（开启 / 关断），与 5.4 precise / rough 机制一致，规模增大时降低输出开销而不影响统计"));
children.push(bullet("协作方式：输出编排器作为后端模块独立于 ns-3 内核，仅消费各采集 trace 回调，不修改通信仿真状态，与 4.1 线程约束及单线程事件注入不冲突"));

children.push(H2("5.10 上位机与 ns-3 内核交互链路"));
children.push(P("鉴于上位机（Windows）与 ns-3 仿真内核（Linux）跨机、跨平台、跨网（2.2 三网），交互不采用参考项目 WiFiViz 的同机共享内存方案，而改用网络化「gRPC 控制 / 配置 + 流式数据通道 + 统一序列化」，三条通道贯通一次 HIL 运行。"));
children.push(bullet("配置 / 下发面（上位机 → 内核）：Electron 前端产出附录 C 的 JSON（hil / topology / halfphysical / protocol）→ gRPC ConfigService / HalfPhysicalService 经控制网下发 → Linux 仿真服务接收后经 ns-3 事件队列注入，遵守 4.1 单线程规则"));
children.push(bullet("控制面（上位机 → 内核）：gRPC ControlService 下发启动 / 停止 / 单步推进 / 离线·HIL 切换 / 时钟源选择，转成 ns-3 事件注入"));
children.push(bullet("数据 / 可视化面（内核 → 上位机）：ns-3 trace 回调 → 5.9 OutputOrchestrator 统一序列化 Header + Events → File 落盘存档或 Memory 取数 → gRPC 流 / WebSocket 经控制网推送 → Electron Vue 订阅渲染"));
children.push(bullet("进程形态：Linux 仿真服务进程内置 gRPC C++ 服务端并直接托管 ns-3（同为一 C++ 进程、共用事件循环），网络请求在进程内转成 Simulator::Schedule 注入，杜绝跨线程改状态"));
children.push(P("一次 HIL 运行的交互时序："));
children.push(...codeBlock([
  "Windows 上位机               Linux 仿真服务                电力仿真器",
  "  Elector/Vue                   ns-3 + gRPC                   主时钟",
  "     │ ① 下发配置(JSON, gRPC)       │                            │",
  "     │──────────────────────────▶  │ 事件队列注入                │",
  "     │ ② 控制(启动, gRPC)           │                            │",
  "     │──────────────────────────▶  │                            │",
  "     │                             │ ◀──────── 步进指令+量测 ────│",
  "     │                             │ step: 事件队列注入+通信域计算 │",
  "     │                             │ ───────── 步进确认 ────────▶│",
  "     │ ③ Header+Events 流(gRPC/WS) │                            │",
  "     │◀────────────────────────────│ trace 回调→Orchestrator     │",
  "     │ 渲染监控面板 / 时间轴回放     │  File落盘 / Memory取数       │",
]));

// ================= 六、非功能与安全设计要求 =================
children.push(H1("六、非功能与安全设计要求"));
children.push(P("本章从性能、可靠性、安全、可维护性与兼容性五个维度明确平台的非功能性约束目标，作为各层设计与评审的验收依据。指标为设计目标值，具体以建成后实测校准。"));

children.push(H2("6.1 性能与容量指标"));
children.push(bullet("通信仿真规模：离线批量仿真支持 ≥ 100 节点 / ≥ 200 链路；HIL 实时模式支持 ≥ 32 个电力终端节点混合组网"));
children.push(bullet("同步精度：HIL 保守步进支持微秒级步长，主从时钟偏差不超过一个仿真步长，满足电磁暂态时序要求"));
children.push(bullet("时延仿真分辨率：虚拟网络单跳时延模拟达报文级（微秒级），性能指标统计误差 ≤ 5%"));
children.push(bullet("前端刷新：运行监控与 HIL 面板毫秒级刷新（目标 ≤ 200 ms），图表曲线 30 FPS 平滑滚动"));
children.push(bullet("半实物承载：单物理网口支持 ≥ 8 个虚拟网卡映射，VLAN ≥ 16 段"));
children.push(bullet("工程规模：单工程支持多工况（≥ 64 个）管理与快速切换"));
children.push(bullet("实时吞吐边界：ns-3 内核单线程，HIL 实时仿真吞吐受单线程上限约束、不随核数提升；当计算量超单步长预算时采用降级策略（裁剪 PHY、增大步长、粗糙采样）"))

children.push(H2("6.2 可靠性"));
children.push(bullet("仿真进程由 Systemd 守护并运行在独立沙箱，崩溃自动拉起，不影响主服务"));
children.push(bullet("后端异常（崩溃 / 断链）时前端主动告警，并保留现场工程与结果供排查"));
children.push(bullet("半实物链路故障监测：实时探测物理网口 / 网桥状态，断链可降级为纯虚拟仿真或安全暂停 HIL"));
children.push(bullet("工程文件写盘原子化，避免中断损坏工程；结果数据支持恢复"));
children.push(bullet("实时数据网低抖动优先，指标采集与业务数据分通道独立，避免相互干扰"));
children.push(bullet("关键状态双通道校验：时间同步状态与步进进度经 gRPC 心跳 + 数据流计数交叉复核"));

children.push(H2("6.3 安全设计"));
children.push(bullet("访问控制：上位机与仿真服务间 gRPC 采用令牌 / 证书鉴权，防止未授权仿真控制"));
children.push(bullet("数据安全：工程与结果数据经 TLS 加密传输，涉敏电力量测数据脱敏后展示"));
children.push(bullet("网络隔离：控制网 / 实时数据网 / 实物接入网三网物理或 VLAN 隔离，实时数据网不与办公网直连"));
children.push(bullet("协议安全：电力报文（IEC 61850 / Modbus）在不影响实时性能前提下做完整性校验，防范注入"));
children.push(bullet("半实物接入防护：真实终端接入前校验 MAC / IP 白名单，拓扑映射变更需二次确认"));
children.push(bullet("审计日志：仿真控制、配置变更、半实物映射操作全量留痕，支持溯源"));

children.push(H2("6.4 可维护性"));
children.push(bullet("插件化扩展（节点 / 协议 / 故障 / 对接）保证新增能力无需改动核心框架"));
children.push(bullet("统一结构化日志规范（分级 + 模块化），支持按模块 / 级别检索"));
children.push(bullet("工程配置与脚本分离、模板化代码生成，便于整体升级与迭代"));
children.push(bullet("前端组件化（Vue）与后端模板化分离，两端可独立维护、独立发布"));

children.push(H2("6.5 兼容与一致性"));
children.push(bullet("构建一致性：统一采用最新稳定版 ns-3（3.46）官方 CMake 构建，明确弃用旧版 Waf 路径，保证与官方内核版本一致"));
children.push(bullet("电力仿真器兼容：以插件方式适配 RTDS / ADPSS / RT-Lab 等主流实时仿真器，可迭代扩展"));
children.push(bullet("技术栈边界清晰：前端 Web 化（Electron / Vue）与后端 C++（ns-3 / gRPC）界限明确，避免混用"));
children.push(bullet("称谓规约：正文统一「交互呈现层（Windows 上位机）」与「半实物终端 / Linux 后端」两大主体，缩写见附录 A"));

// ================= 七、代码生成模块详细设计 =================
children.push(H1("七、代码生成模块详细设计"));
children.push(P("代码生成模块是本平台「配置 → 运行」衔接枢纽。设计融合 NS3-GUI-HELPER 的对象多态分派（低扩展成本）与 WiFiViz 的 section 编排 + 强校验（高可用），并结合本平台电力业务流、协议插件与 HIL / 半实物注入诉求。目标：新增节点 / 链路 / 协议 / 故障类型不改动生成主流程，生成物为可编译、带注入开关的自包含 ns-3 C++ 脚本。"));

children.push(H2("7.1 模块组成与职责"));
children.push(bullet("TopologyModel 对象模型：统一描述节点、链路、网络、协议、故障、半实物映射，是 UI、校验、生成三方共享的唯一数据源"));
children.push(bullet("Validator 校验器：生成前校验拓扑 id ↔ 节点配置 ↔ 半实物映射一致性及协议参数合法性，失败时定位到具体配置项并阻断"));
children.push(bullet("ElementEmitter 片段发射器：每类节点 / 链路 / 协议对象实现统一 toCode()，返回自身 ns-3 代码片段（多态分派，新增类型仅新增类）"));
children.push(bullet("SectionBuilder 分节编排器：按固定顺序（Header→参数→节点→链路→协议→业务流→HIL/半实物注入→采集→主函数）串联各类片段"));
children.push(bullet("InjectSwitcher 注入开关：以 CLI 参数控制离线 / HIL、采样率、是否注入 SniffUtils / HIL 同步引擎，同一模型生成多形态脚本"));
children.push(bullet("OutputWriter 输出：生成自包含 .cc 写入工程目录，并返回编译入口与运行说明"));

children.push(H2("7.2 对象模型接口"));
children.push(P("约定统一生成元素契约，节点、链路、协议、故障、半实物映射均实现之，生成器仅遍历调用，与插件化机制（4.5）对接。"));
children.push(...codeBlock([
  "interface IGenElement {              // 生成元素统一契约",
  "  String   id();                     // 语义标识（如 IED_1 / 光伏_2）",
  "  boolean  validate();               // 元素级校验",
  "  String[] toCode();                 // 自身 ns-3 代码片段（多态分派）",
  "  String   forSettings();            // 默认参数持久化 JSON",
  "}",
  "// 具体实现（对应插件）",
  "class NodeElement        implements IGenElement; // 电力 / 通信节点",
  "class LinkElement        implements IGenElement; // P2P / CSMA / 无线链路",
  "class ProtocolElement    implements IGenElement; // IEC 61850 MMS/GOOSE、Modbus",
  "class FaultElement       implements IGenElement; // 通信层故障 / 攻击",
  "class HalfPhysicalElement implements IGenElement; // Tap↔节点↔单网口映射",
  "// 生成主流程（保持不变，仅遍历调用）",
  "class Generator {",
  "  code = obj.validate() ? ",
  "    Header + SectionBuilder.build(elements).apply(InjectSwitcher.cli) : reject(position);",
  "}",
]));

children.push(H2("7.3 生成管线与数据流"));
children.push(...codeBlock([
  "JSON 中间态（拓扑 / 协议 / HIL / 半实物）",
  "      │",
  "      ▼",
  " ① Validator 校验（id↔配置↔半实物映射、协议参数合法性）",
  "      │ 失败→定位配置项并阻断",
  "      ▼",
  " ② 实例化 TopologyModel，生成各 IGenElement",
  "      │",
  "      ▼",
  " ③ ElementEmitter 多态分派收集 toCode() 片段",
  "      │",
  "      ▼",
  " ④ SectionBuilder 按序编排（Header→…→业务流→HIL/半实物注入）",
  "      │",
  "      ▼",
  " ⑤ InjectSwitcher 按 CLI 追加尾段（离线 / HIL / 采样率）",
  "      │",
  "      ▼",
  " ⑥ OutputWriter 写出自包含 .cc → 工程目录",
]));

children.push(H2("7.4 电力业务流建模"));
children.push(bullet("业务流以 JSON Flows[] 描述，语义端点用 IED_x / 光伏_x / 储能_x / RTU_x 标识，后端映射为节点 / 地址"));
children.push(bullet("流类型：Periodic 定时遥测、Event 突发遥信、Control 控制下发、CBR、OnOff，覆盖电力典型报文时序"));
children.push(bullet("时序分布：支持 Constant / Exponential / Uniform / Gaussian，映射 ns-3 随机变量，表达周期 / 突发 / 抖动"));
children.push(bullet("协议绑定：每条流可绑定 ProtocolElement（GOOSE 快速事件 / MMS / Modbus），生成对应报文逻辑"));
children.push(bullet("协议承载分层：严格区分 L3 协议（MMS / Modbus 走 TCP/IP，经 Socket+端口分配）与 L2 协议（GOOSE 为二层以太网协议，EtherType 0x88B8、承载于以太网帧而非 IP）；GOOSE 走独立的应用层 L2 帧发送路径，不进入 IP 寻址 / 自动端口分配流程"));
children.push(bullet("自动端口分配：仅对 L3 协议按唯一目标分配端口，多目标自动生成 PacketSink / 服务器节点"));
children.push(bullet("缺省回退：未配流量时生成默认上下行业务流，保证产物可运行"));

children.push(H2("7.5 HIL 与半实物注入点"));
children.push(bullet("HIL 注入：生成脚本内置保守步进同步引擎接入点，经 ns-3 外部事件队列与电力仿真器步进握手，微秒级步长；同步判断基于外部真实时钟，不经 Simulator::Now()"));
children.push(bullet("协议注入：L3 协议（MMS / Modbus）经 ns-3 Socket 挂载于节点应用层；GOOSE 经自定义二层发送路径直接构造以太网帧（EtherType 0x88B8）发射，物理侧可利用 EmuNetDevice 透明透传"));
children.push(bullet("半实物注入：按 HalfPhysicalElement 生成 Tap（EmuNetDevice）+ 二层网桥代码，将指定仿真节点桥接至 Linux 单一物理网口"));
children.push(bullet("采集注入：注入 SniffUtils 式 trace 采集（通信指标、同步状态、业务数据），经流式通道推送前端"));
children.push(bullet("CLI 开关：--hil / --offline、--precise / --rough、--emu <intf>，同模型产出离线 / HIL / 半实物多形态脚本"));

children.push(H2("7.6 校验与错误处理"));
children.push(bullet("一致性校验：拓扑引用节点 id 与节点配置、半实物映射三方数量与标识一致，否则报错并定位配置项"));
children.push(bullet("协议参数校验：IEC 61850 / Modbus 关键参数（地址、数据类型、周期）在生成期检查，非法即阻断"));
children.push(bullet("冲突检测：半实物节点与普通节点争用同一网卡 / 端口、流目标悬空均被检出"));
children.push(bullet("可读性：生成脚本带分区注释与语义命名，报错信息携带配置文件与字段路径"));

children.push(H2("7.7 生成产物"));
children.push(bullet("自包含性：生成 .cc 不依赖运行期 JSON，所有参数硬编码，可直接 ns-3 CMake 构建运行"));
children.push(bullet("产物落位：写入工程目录（附录 C），同时生成构建 / 运行说明与 CLI 帮助"));
children.push(bullet("可追溯：产物头部标注来源工程、生成时间、生成器版本，与工况 JSON 双向对应"));
children.push(bullet("运行输出统一：生成的仿真运行时经 5.9 输出编排器产出 Header + Events 事件文档，离线落盘存档、内存流式推送前端，与 .cc 产物共同构成「生成 → 运行 → 回看」闭环"));

// ================= 八、部署与实施路线 =================
children.push(H1("八、部署与实施路线"));
children.push(P("本章给出平台落地部署形态与分阶段实施路线，使架构可直接推进到工程开发。"));

children.push(H2("8.1 部署形态"));
children.push(bullet("Windows 上位机：Electron 打包应用（Vue3 前端 + Node 侧 gRPC 客户端），发布为安装包，经控制网连接 Linux 仿真服务"));
children.push(bullet("Linux 仿真服务：独立进程运行，systemd 单元守护与自动拉起，按模块划分沙箱"));
children.push(bullet("实时数据网：仿真服务与电力仿真器专用局域网，低抖动，可选 PTP 网卡对齐墙钟"));
children.push(bullet("实物接入网：仿真服务单一物理网口汇聚全部半实物终端，二层网桥 + VLAN 隔离"));

children.push(H2("8.2 四阶段实施路线"));
children.push(table(
  ["阶段", "范围", "出口标准"],
  [
    ["L0 配置与生成", "Web 呈现层 + 拓扑对象模型 + 代码生成 + 离线仿真", "ns-3.46 CMake 构建环境就绪；画拓扑→校验→生成→构建运行离线场景"],
    ["L1 可视化与工况", "结果面板体系、流式通道、工况库、工程持久化", "离线仿真实时可视化 + 多工况管理"],
    ["L2 HIL 闭环", "保守同步引擎、仿真器对接插件、时钟源选择（PTP / 内置）、双模式切换", "电力仿真器 + ns-3 HIL 闭环步进跑通；时钟源 PTP / 内置切换与自动回退验证；同步引擎（外部事件桥 + 自定义保守步进）为高风险/高成本项，须单独预留开发与联调周期"],
    ["L3 半实物与加固", "半实物单网口 + 上位机映射、插件扩展、安全加固", "真实终端接入并通过功能与安全验收"],
  ],
  [1500, 4200, 4700]
));

children.push(H2("8.3 里程碑衡量"));
children.push(bullet("L0：5 分钟内从空拓扑生成并运行一个 ≥3 节点离线场景"));
children.push(bullet("L1：≥100 节点离线批量，前端刷新 ≤200ms，工况 ≥64 管理"));
children.push(bullet("L2：微秒级同步偏差 ≤ 一个步长，双模式一键切换无需重建模型；时钟源 PTP / 内置切换下发与自动回退告警验证通过"));
children.push(bullet("L3：单网口 ≥8 终端映射，全插件化扩展，通过 6.3 安全项验收"));

// ================= 九、第三方依赖与许可证合规 =================
children.push(H1("九、第三方依赖与许可证合规"));
children.push(P("本章明确平台所引入的全部第三方组件的许可证归属与传染边界，作为产品化交付与商业化授权决策的依据。判定结论基于各组件的官方 LICENSE 文本及项目官方声明；涉及 GPL 进程边界的争议情形见 9.3。"));

children.push(H2("9.1 依赖清单与许可证判定"));
children.push(P("平台分别在 Windows 上位机与 Linux 仿真服务两端引入第三方组件，两端许可证风险差异显著，逐项判定如下。"));
children.push(table(
  ["组件", "引入位置", "许可证", "传染强度", "商用判定"],
  [
    ["ns-3.46 通信内核", "3.4 / 3.5 / 5.10", "GPLv2-only", "强", "阻断，见 9.2"],
    ["libiec61850", "3.2 电力协议", "GPLv3（MZ Automation 双授权）", "强", "阻断，见 9.2"],
    ["EmuNetDevice / TapBridge", "3.2 / 4.3 / 7.5", "GPLv2（ns-3 内核组成部分）", "强", "随 ns-3 受限"],
    ["libmodbus", "3.2 电力协议", "LGPL-2.1+", "弱", "可控，动态链接即可闭源"],
    ["linuxptp（PTP 实现）", "4.1 / 8.1", "GPLv2", "弱", "建议由客户系统提供，不随包分发"],
    ["systemd", "6.2 / 8.1", "LGPL-2.1", "弱", "进程级调用，可用"],
    ["Linux 内核", "2.2 / 4.3", "GPLv2", "无", "运行平台，不修改内核即可"],
    ["Electron（Chromium / Node）", "3.1", "MIT / BSD", "无", "可用，保留声明"],
    ["Vue 3 / Vite / Pinia / Vue Router", "3.1", "MIT", "无", "可用，保留声明"],
    ["AntV X6", "3.1", "MIT", "无", "可用，保留声明"],
    ["ECharts", "3.1", "Apache-2.0", "无", "可用，保留声明与 NOTICE"],
    ["Element Plus", "3.1", "MIT", "无", "可用，保留声明"],
    ["gRPC C++", "3.2", "Apache-2.0", "无", "可用，保留声明与 NOTICE"],
    ["NS3-GUI-HELPER（设计借鉴）", "5.8", "MIT", "无", "仅借鉴设计思路，无需开源"],
    ["WiFiViz（设计借鉴）", "5.7", "MIT", "无", "仅借鉴设计思路，无需开源"],
    ["NetSimulyzer（外置调用）", "3.1 / 5.9", "NIST 公共式许可", "无", "独立进程调用，须显式致谢 NIST"],
  ],
  [1500, 1400, 2600, 1100, 3800]
));
children.push(P("结论：Windows 上位机侧组件全部为 MIT / Apache-2.0 / BSD 类宽松许可，可闭源商用；风险全部集中在 Linux 仿真服务侧的 ns-3 与 libiec61850。"));

children.push(H2("9.2 三处硬阻断"));
children.push(P("一、ns-3 与自研代码同进程。5.10 明确「Linux 仿真服务进程内置 gRPC C++ 服务端并直接托管 ns-3（同为一 C++ 进程、共用事件循环）」。自研 gRPC 服务端与 GPLv2-only 的 ns-3 处于同一可执行程序，构成单一作品，按 GPLv2 须整体开源。第四、五、七章所述的 HIL 同步引擎、电力节点模型库、故障注入引擎、协议适配模块、代码生成器均将随之外泄。"));
children.push(P("二、libiec61850 的开源义务。MZ Automation 官方声明：GPLv3 许可下任何使用其开源代码者均须公开自身源码；商用须另行购买商业授权。该项不存在免费且闭源的路径。"));
children.push(P("三、GPLv2-only 与 GPLv3 法律互斥。ns-3 官方贡献指南明确：ns-3 作为整体以 GPLv2-only 授权，既不可按 GPLv2-or-later 亦不可按 GPLv3 再分发，且不接受 GPLv3 或 Apache 许可的代码进入主线。因此 ns-3 与 libiec61850 不可同时出现在任一可分发的交付物中。3.2 节将二者置于同一后端、5.10 节将二者置于同一进程的写法，须在交付形态上予以规避。"));

children.push(H2("9.3 知识产权边界（架构约束）"));
children.push(P("为在保留核心资产的前提下实现商用，架构层明确一条硬边界。"));
children.push(bullet("上位机侧（可闭源）：拓扑建模、配置、校验、代码生成整条链路位于 Windows 上位机，生成器承载于 Electron 主进程（Node / TS 侧），渲染进程经 IPC 调用；该边界内的全部代码不接触 GPL 组件。"));
children.push(bullet("Linux 侧（受 GPL 约束）：仅承担「消费生成产物并运行」的职责，不承载平台的差异化能力。"));
children.push(bullet("交付物不含 ns-3 二进制：安装包仅含 Windows 上位机、生成的 .cc 脚本与 JSON 中间态，ns-3 由客户在其自有环境安装；客户内部自用不触发 GPL 的分发义务。"));
children.push(bullet("后续扩展约束：凡纳入 Linux 侧的模块（HIL 同步引擎、电力协议适配等）在对外交付时均须按 GPL 开源；若需闭源，须上移至上位机侧或改用商业授权组件。"));
children.push(P("该边界同时是 5.10 交互链路与第七章生成器承载位置的架构依据。"));

children.push(H2("9.4 交付形态与合规路线"));
children.push(table(
  ["路线", "做法", "可行性", "成本"],
  [
    ["A 分层交付（推荐）", "上位机闭源收费；Linux 端不交付二进制，ns-3 由客户自装；libiec61850 改商业授权", "高", "libiec61850 授权费"],
    ["B 强 copyleft 替换", "自研 IEC 61850 协议栈；自研通信仿真内核替代 ns-3", "高", "极高，不建议"],
    ["C Linux 端全开源", "按 GPL 开源 Linux 端，以服务与定制收费", "不成立", "须先移除 libiec61850 方可成立"],
  ],
  [1900, 5000, 1200, 2300]
));
children.push(P("libmodbus 的 LGPL-2.1 按以下方式满足：Linux 端动态链接 libmodbus.so，不修改其源码，并在第三方声明中标注其许可证。"));

children.push(H2("9.5 交付合规清单"));
children.push(bullet("安装包随附 THIRD-PARTY-NOTICES.txt，覆盖 Electron、Chromium、Vue、Vite、AntV X6、ECharts、Element Plus、Pinia、Vue Router、gRPC"));
children.push(bullet("Electron 打包产物保留 LICENSE.electron.txt 与 LICENSES.chromium.html"));
children.push(bullet("交付文档明确 ns-3 不由平台分发、由客户自行安装"));
children.push(bullet("libiec61850 完成商业授权签署，或在首版中移除"));
children.push(bullet("libmodbus 确认动态链接方式，并在声明中标注 LGPL-2.1"));
children.push(bullet("显式致谢 NIST（NetSimulyzer 许可要求）"));
children.push(bullet("标注 WiFiViz、NS3-GUI-HELPER 的 MIT 版权归属及「仅借鉴架构设计思路」声明"));
children.push(bullet("商业发布前由知识产权律师复核 GPL 进程边界的认定"));

// ================= 附录 =================
children.push(H1("附录"));
children.push(H2("附录 A 术语与缩略词表"));
children.push(table(
  ["术语 / 缩写", "解释"],
  [
    ["HIL", "硬件在环（Hardware-in-the-Loop），真实物理终端与虚拟仿真混合闭环"],
    ["ns-3", "开源离散事件网络仿真器，本平台通信仿真内核"],
    ["RTDS / ADPSS / RT-Lab", "电力实时仿真器，承担电磁 / 机电暂态计算"],
    ["IEC 61850", "变电站 / 配电网通信标准；MMS 制造报文规范，GOOSE 面向通用对象的快速事件报文"],
    ["Modbus RTU / TCP", "工业 / 电力设备常用协议，支持串行（RTU）与以太网（TCP）传输"],
    ["IED", "智能电子设备（Intelligent Electronic Device），保护测控装置"],
    ["RTU", "远方终端单元"],
    ["Tap / EmuNetDevice", "Linux 虚拟以太网设备及 ns-3 接入其的设备，承载虚实网络桥接"],
    ["PTP", "精密时间协议，硬件时钟对齐基准"],
    ["上位机", "即交互呈现层（Windows 端软件），Windows 上位机与交互呈现层在本文指代同一主体"],
    ["半实物终端 / 真实终端 / 实物模式", "本文统一指真实物理接入设备（IED / RTU / 光伏 / 储能逆变器等），其仿真接入统称「半实物接入」"],
    ["ns-3.46 / CMake 构建", "版本统一口径：本平台通信内核采用最新稳定版 ns-3.46，以官方 CMake 构建系统编译（使用官方 ns3 包装工具），明确不采用旧版 Waf 构建路径（详见 3.5）"],
  ],
  [2200, 6500]
));

children.push(H2("附录 B 跨端接口清单（草案）"));
children.push(P("跨端接口层基于 gRPC 服务定义，覆盖工程管理、仿真控制、数据订阅、HIL 配置四大类，首版接口划分如下（草案，随迭代增补）。"));
children.push(table(
  ["服务", "方法方向", "职责说明"],
  [
    ["ProjectService", "前端 → 后端", "工程新建 / 保存 / 加载 / 列表与版本管理"],
    ["TopologyService", "双向", "拓扑数据上传 / 下发 / 校验与电力节点扩展字段"],
    ["ControlService", "前端 → 后端", "仿真启动 / 停止 / 单步推进 / 离线·HIL 模式切换"],
    ["ConfigService", "双向", "工况与 HIL 对接参数读取 / 写入 / 下发（含 HIL 时钟源：PTP 精密时钟 / 内置时钟）"],
    ["SubscribeService", "后端 → 前端（流式）", "指标流 / 日志流 / 同步状态流低延迟推送"],
    ["HalfPhysicalService", "前端 → 后端", "虚拟网卡分配、节点一一映射、单物理网口与 VLAN 配置下发"],
  ],
  [2200, 2300, 4200]
));

children.push(H2("附录 C 工程目录与 JSON 结构（草案）"));
children.push(P("沿用 5.5 的工程化目录约定，单工况工程目录结构示例如下，配置均以 JSON 为中间态「配置 → 脚本 → 运行」复用。"));
children.push(...codeBlock([
  "Designed_<timestamp>/",
  "├── project.json              # 工程概要（名称 / 版本 / 模式 / 关联配置清单）",
  "├── topology/<topo>.json      # 拓扑数据（通用通信设备 + 电力节点 + 链路）",
  "├── hil/<hil>.json            # HIL 对接参数（仿真器类型 / 步长 / 同步策略 / 时钟源：PTP或内置）",
  "├── halfphysical/<map>.json   # 半实物映射（虚拟网卡 ↔ 节点 ↔ 单物理网口 / VLAN）",
  "├── protocol/<proto>.json     # 电力协议参数（IEC 61850 MMS / GOOSE、Modbus）",
  "└── results/<run_t>/          # 结果与日志（指标 / 报文 / 运行日志 / 报告）",
]));

// ---------- 文档 ----------
const doc = new Document({
  numbering: {
    config: [
      {
        reference: "bullets",
        levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
      },
      {
        reference: "numbers",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
      },
    ],
  },
  styles: {
    default: { document: { run: { font: FONT, size: 22 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 32, bold: true, font: FONT },
        paragraph: { spacing: { before: 360, after: 240 }, outlineLevel: 0, keepNext: false, keepLines: false } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 27, bold: true, font: FONT },
        paragraph: { spacing: { before: 260, after: 180 }, outlineLevel: 1, keepNext: false, keepLines: false } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 24, bold: true, font: FONT },
        paragraph: { spacing: { before: 200, after: 140 }, outlineLevel: 2, keepNext: false, keepLines: false } },
    ],
  },
  sections: [{
    properties: {
      page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
    },
    children,
  }],
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(path.join(__dirname, "电力通信融合硬件在环仿真平台_架构设计说明书.docx"), buf);
  console.log("DONE: docx written");
});