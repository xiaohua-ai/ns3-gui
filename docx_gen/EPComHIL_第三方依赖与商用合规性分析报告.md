# EPComHIL 电力通信融合硬件在环仿真平台
# 第三方依赖与商用合规性分析报告

> 分析对象：《电力通信融合硬件在环仿真平台_架构设计说明书.docx》（8 章 + 3 附录，2026-09-17 版）
> 分析范围：架构所引用的全部第三方组件、参考项目与其许可证，及其对软件商业化（对外分发）的影响
> 日期：2026-09-17

---

## 一、结论

**不能按当前架构直接商用（对外分发二进制）。可以商用，但必须改变交付形态。**

三处硬阻断 + 一处法律互斥：

| # | 阻断项 | 架构位置 | 性质 |
|---|---|---|---|
| 1 | ns-3（GPLv2-only）与自研 gRPC 服务端同进程链接 | 3.4 / 5.10 | 传染 → 整个 Linux 端必须开源 |
| 2 | libiec61850（GPLv3 双授权） | 3.2 | 开源或付费，二选一 |
| 3 | ns-3 与 libiec61850 被置于同一后端 | 3.2 + 5.10 | **GPLv2-only 与 GPLv3 法律互斥，不可合并分发** |

其中第 3 项最隐蔽、也最致命：**即使你决定「Linux 端全部开源」，也无法把 ns-3 和 libiec61850 打进同一个交付物。**

ns-3 官方贡献指南原文：

> Strictly speaking, ns-3 as an aggregate is licensed as GNU GPLv2-only and cannot be redistributed either as GNU GPLv2-or-later or as GNU GPLv3. ns-3 cannot accept GNU GPLv3 or Apache licensed code into the mainline because those licenses are not compatible with GNU GPLv2-only.

---

## 二、逐项判定

### 2.1 有风险的组件

| 组件 | 架构位置 | 许可证 | 传染强度 | 商用判定 |
|---|---|---|---|---|
| ns-3.46 通信内核 | 3.4 核心依赖、3.5 版本基线、5.10 同进程托管 | **GPLv2-only** | 强（进程内链接即派生作品） | ⛔ 硬阻断 |
| libiec61850 | 3.2 电力协议 | **GPLv3**（MZ Automation 双授权） | 强 | ⛔ 硬阻断，且与 ns-3 互斥 |
| EmuNetDevice / TapBridge / Linux Tap 网桥 | 3.2、4.3、7.5 | GPLv2（ns-3 内核组成部分） | 强 | ⛔ 随 ns-3 一并受限 |
| libmodbus | 3.2 电力协议 | **LGPL-2.1+** | 弱 | ⚠️ 可控（见 2.3） |
| PTP（linuxptp 实现） | 4.1、8.1 | GPLv2 | 弱 | ⚠️ 建议由客户系统提供，不随包分发 |
| Systemd | 6.2、8.1 | LGPL-2.1 | 弱 | ✅ 进程级调用，不构成派生作品 |
| Linux 内核 | 2.2、2.3、4.3 | GPLv2 | 无（运行平台） | ✅ 只要不修改内核、不静态链接内核符号 |

### 2.2 无风险的组件

| 组件 | 架构位置 | 许可证 | 约束 |
|---|---|---|---|
| Electron（Chromium + Node.js） | 3.1 应用外壳 | MIT（Chromium 部分 BSD） | 随包保留 LICENSE.electron.txt / LICENSES.chromium.html |
| Vue 3 / Vite / TypeScript | 3.1 | MIT / MIT / Apache-2.0 | 保留声明 |
| AntV X6 拓扑建模 | 3.1 | MIT | 保留声明 |
| ECharts 性能曲线 | 3.1 | Apache-2.0 | 保留 NOTICE |
| Element Plus 组件库 | 3.1 | MIT | 保留声明 |
| Pinia / Vue Router | 3.1 | MIT | 保留声明 |
| gRPC C++ 服务端 | 3.2 | Apache-2.0 | 保留 NOTICE |
| NS3-GUI-HELPER（设计借鉴） | 5.8 | **MIT**（Copyright (c) 2023 Henil Mistry） | ✅ 仅借鉴设计思路无需开源；若复用源码须保留版权声明 |
| WiFiViz（设计借鉴） | 5.7 | **MIT**（Copyright (c) 2026 Zhang Kai, Mi Chengxiang） | 同上 |
| NetSimulyzer（外置调用） | 3.1 表、5.9 | **NIST 公共式许可** | ✅ 独立进程调用，隔离良好；须显式致谢 NIST |

NetSimulyzer 的 LICENSE.md 明确要求：

> Please explicitly acknowledge the National Institute of Standards and Technology as the source of the software.

### 2.3 libmodbus 的 LGPL 边界

LGPL-2.1 允许闭源商用，但**链接方式决定义务**：

| 链接方式 | 是否可闭源 | 附加义务 |
|---|---|---|
| 动态链接 libmodbus.so | ✅ 可以 | 声明使用了 libmodbus 及其许可证 |
| 静态链接 libmodbus.a | ⚠️ 有条件 | 须提供目标文件（.o）或可重链接的等价物，使用户能替换该库 |
| 修改了 libmodbus 源码 | ⛔ 传染 | 修改部分须按 LGPL 开源 |

**建议**：Linux 端统一使用动态链接，并在 `THIRD-PARTY-NOTICES.txt` 中声明。

---

## 三、三处硬阻断的具体拆解

### 3.1 ns-3 GPLv2-only —— 5.10 同进程托管

架构 5.10 原文：

> 进程形态：Linux 仿真服务进程内置 gRPC C++ 服务端并直接托管 ns-3（同为一 C++ 进程、共用事件循环），网络请求在进程内转成 Simulator::Schedule 注入，杜绝跨线程改状态。

自研 gRPC 服务端与 ns-3 处于同一可执行程序 → 构成单一作品（single work）→ 按 GPLv2 须整体开源。

**随之需开源的核心资产（清单）**：

| 模块 | 架构位置 | 资产价值 |
|---|---|---|
| HIL 保守步进同步引擎 | 4.1 | ★★★★★ 核心算法 |
| 电力节点模型库（光伏/储能/IED/RTU） | 4.2、7.4 | ★★★★ |
| 故障注入引擎 | 4.5、7.5 | ★★★ |
| 电力协议适配模块 | 3.2、7.4 | ★★★★ |
| 半实物接入管理（虚拟网卡映射） | 4.3、7.5 | ★★★★ |
| 规格化代码生成器 | 第七章 | ★★★★★ |

### 3.2 libiec61850 GPLv3 —— 开源或付费

MZ Automation 官方立场：

> MZ automation uses the GPLv3 license so anyone that downloads our libraries will be required to release their source code if they use any part of our open-source code.

商用必须向其购买商业授权（按项目/产品计费，含 SCL/CID 解析器等增强功能与支持）。官方免费提供试用授权。

### 3.3 GPLv2-only × GPLv3 互斥

| 组合 | 是否可分发给同一客户 |
|---|---|
| ns-3（GPLv2-only）+ 自研闭源代码 | ⛔ 不可（自研代码必须 GPLv2 开源） |
| ns-3（GPLv2-only）+ 自研代码（GPLv2 开源） | ✅ 可 |
| libiec61850（GPLv3）+ 自研代码（GPLv3 开源） | ✅ 可 |
| **ns-3（GPLv2-only）+ libiec61850（GPLv3）** | **⛔ 不可，任何形式都不行** |
| **ns-3（GPLv2-only）+ libiec61850（商业授权）** | ✅ 可（商业授权无 GPL 义务） |

结论：**libiec61850 这一项，要么买商业授权，要么完全不用。** 没有「都开源」这条退路。

---

## 四、三条可行商用路线

| 路线 | 做法 | 商用可行性 | 成本 | 备注 |
|---|---|---|---|---|
| **A｜分层交付**（推荐） | Windows 上位机闭源收费；Linux 端不交付二进制，只交付「配置 JSON + 生成的 .cc 脚本」，由客户在自己环境安装 ns-3 构建运行；libiec61850 换商业授权 | 高 | 中等 | 业界通行做法，客户内部自用不触发 GPL 分发义务 |
| **B｜强 copyleft 全替换** | IEC 61850 自研 MMS/GOOSE 子集；ns-3 替换为自研离散事件内核 | 高（但慢） | 极高 | 不建议，自研内核与国内协议栈的工程量不成立 |
| **C｜Linux 端全开源** | Linux 端按 GPL 开源，靠定制实施与服务收费 | 中 | 高 | **必须先去 libiec61850**（互斥），否则路线本身不成立 |

### 4.1 路线 A 的落地要点

1. **知识产权边界右移**：把「建模 → 校验 → 代码生成」整条链留在 Windows 上位机（Electron 主进程 / Node 侧），Linux 端只做「消费 .cc 并运行」。
   - 这一条**先行版已经踩对了**：`EPComHIL/IMPLEMENTATION_PLAN.md` 的 W7 明确「生成器承载位置：放 Electron 主进程（Node/TS 侧），渲染进程经 IPC 调用」。
   - 建议在架构说明书里把这条从「可移植性优化」**升级为明文的 GPL 隔离边界**，作为商用路线的架构依据。
2. **Linux 端不作为交付物**：安装包、部署文档面向客户时，ns-3 由客户自行安装（发行版包管理器或源码）。你只交付拓扑配置与生成脚本。
3. **libiec61850 决策**：若目标客户对 IEC 61850 有硬需求 → 询价购买商业授权；若可降级 → 先只交付 Modbus（libmodbus，LGPL 友好）。
4. **上位机侧可放心闭源**：Electron / Vue / X6 / ECharts / Element Plus 全部宽松许可，商用授权加密（如 License 授权、机器码绑定）无障碍。

---

## 五、架构说明书本身的缺口（评审会被挑出）

| # | 问题 | 位置 | 严重度 | 建议 |
|---|---|---|---|---|
| 1 | **全文无「第三方依赖与许可证」章节** | 全文 | 高 | 新增第九章，含依赖清单、许可证、归属声明、交付合规清单 |
| 2 | **4 处非法 XML 节点 `<0/>`**（生成器占位符未替换） | 5.10 时序图后、7.2、7.3、附录 C | 高 | 修复 gen.js 占位符替换逻辑并重新生成；当前文档在 Word 中会报「内容有问题」 |
| 3 | 「深度借鉴 WiFiViz / NS3-GUI-HELPER」未标注借鉴方许可证归属 | 5.7、5.8 | 中 | 补一句「仅借鉴架构设计思路，未复用其源代码」，并列出 MIT 版权归属 |
| 4 | 未体现对 NIST 的致谢（NetSimulyzer 许可要求） | 3.1、5.9 | 中 | 在致谢或第九章中显式致谢 NIST |
| 5 | 版本表述「最新稳定版 ns-3.46」已过期 | 3.4、3.5、附录 A | 低 | 2026-06 已发布 ns-3.48（3.5 节有「撰写时」限定，问题不大，建议更新口径） |

> 注：问题 2 是本次分析中把文档解包逐节点校验时发现的 —— `<0/>` 不是合法 WordprocessingML 元素，属于生成脚本的脏输出。

---

## 六、商用交付合规清单

- [ ] 随安装包发布 `THIRD-PARTY-NOTICES.txt`，覆盖 Electron、Chromium、Vue、Vite、AntV X6、ECharts、Element Plus、Pinia、Vue Router、gRPC
- [ ] Electron 打包产物保留 `LICENSE.electron.txt` 与 `LICENSES.chromium.html`
- [ ] 架构说明书补第九章「第三方依赖与许可证」，并标注 GPL 边界
- [ ] 明确 ns-3 不作为交付物（客户自装），在交付文档中写明
- [ ] libiec61850：完成商业授权签约，或在首版中移除
- [ ] libmodbus：确认动态链接，文档中声明 LGPL-2.1
- [ ] NetSimulyzer：显式致谢 NIST
- [ ] WiFiViz / NS3-GUI-HELPER：文档标注 MIT 归属 + 「仅借鉴设计」声明
- [ ] 修复 4 处 `<0/>` 占位符并重新生成架构说明书

---

## 七、免责说明

本报告基于公开许可证文本与官方声明作出的工程合规判断，**不构成法律意见**。ns-3 的进程边界是否构成规避、生成产物的派生作品认定等属争议地带，正式商用前建议由知识产权律师复核。

## 附：核实来源

| 事项 | 来源 |
|---|---|
| ns-3 GPLv2-only、不兼容 GPLv3 | ns-3 Contributing Guide §2.1 Licensing（nsnam.org） |
| ns-3 无商业版 | nsnam.org 项目首页 |
| libiec61850 GPLv3、商业授权 | mz-automation.de / libiec61850.com / GitHub mz-automation/libiec61850 |
| libmodbus LGPL-2.1 | libmodbus.org、GitHub stephane/libmodbus |
| AntV X6 MIT | x6.antv.vision 官方文档「开源协议」 |
| NS3-GUI-HELPER MIT | 仓库 LICENSE（MIT，Copyright (c) 2023 Henil Mistry） |
| WiFiViz MIT | 仓库 LICENSE（MIT，Copyright (c) 2026 Zhang Kai, Mi Chengxiang） |
| NetSimulyzer NIST 许可 | 仓库 LICENSE.md + THIRD_PARTY_LICENSES.md |
