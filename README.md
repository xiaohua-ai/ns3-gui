# ns3-gui

电力通信融合硬件在环仿真平台（EPComHIL）相关工具集。

## 子项目

| 目录 | 说明 | 版本 |
| --- | --- | --- |
| `EPComHIL/` | 电力通信融合硬件在环仿真平台（Windows 上位机先行版）。Electron + Vue3 + TypeScript + Vite，负责拓扑建模 → 配置(L2/L3/业务流/半实物/HIL) → 强校验 → 代码生成 → 导出 ns-3 工程。 | 0.2.0 |
| `docx_gen/` | 基于 `docx` 的报告文档生成工具，用于生成平台架构设计说明书等 Word 文档。 | 1.0.0 |

## 目录约定

```
EPComHIL/      Electron 主进程 + Vue3 渲染进程 + 生成器 + 单测
docx_gen/      docx 报告生成脚本与产物
```

## 说明

- 第三方 ns-3 / 网络可视化工具（NetSimulyzer、NS3-GUI-Helper、WiFiViz）为本地参考依赖，**不纳入本仓库**，已在 `.gitignore` 中排除。
- `node_modules/`、构建产物、`*.local`、`.workbuddy/` 等亦被忽略。

## 相关

- EPComHIL 导出的 ns-3 工程由 Linux 端 ns-3 消费；本仓聚焦 Windows 上位机与文档生成。
