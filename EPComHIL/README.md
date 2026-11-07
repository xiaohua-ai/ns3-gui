# EPComHIL · 电力通信融合硬件在环仿真平台（Windows 上位机先行版）

先行版范围：**拓扑建模 → 配置(L2/L3 协议/业务流/半实物/HIL) → 强校验 → 代码生成 → 导出 ns-3 项目代码**。Linux 端 ns-3、HIL 闭环、半实物接入为后续阶段。

## 技术栈

- 外壳 Electron + Vue3 + TypeScript + Vite
- UI：Element Plus（深色工业主题）+ AntV X6（拓扑画布）+ ECharts（图表，后续）
- 生成器：置于 Electron 主进程 Node 侧，经 IPC 由渲染进程调用（后续换 gRPC 对接 Linux 端）

## 目录约定

```
electron/           Electron 主/预加载进程（含 W8 导出写盘 IPC）
src/renderer/       前端（Vue3）：layout/ views/ stores/ router/
src/core/           数据模型：types.ts · IGenElement.ts · Validator.ts · model/
src/generator/      代码生成：catalog · context · builder · injectSwitcher · generator · outputWriter
samples/            示例工况（JSON，供测试与导入）
test/               vitest 单测（生成快照 / 反例 / 导出）
```

## 常用命令

```bash
npm install               # 安装依赖
npm run dev               # 开发：Vite + Electron（HMR）
npm run test              # vitest 单测（生成器/校验/导出）
npm run typecheck         # vue-tsc 类型检查
npm run vite:build        # 仅构建渲染进程
npm run build             # 渲染进程 + electron-builder 打包 Windows 安装包
```

## 导出说明

在「导出」页面配置模式/时钟源/采样/停止时间后点击「生成预览」，可查看四层中间输出（中间 JSON / 校验报告 / 生成日志 / `.cc`）；校验通过后可「导出 ns-3 项目代码」，生成 `Designed_<timestamp>/` 工程目录（含 `.cc`、`project.json`、`validation.json`、`build/`、`README.md`），供 Linux 端 `ns-3.38`（CMake 构建，已弃用 Waf）消费。

## 数据流（先行版）

`Electron 渲染(建模/配置) → store(ProjectConfig) → 校验(Validator) → 生成(builder/Emitter/Section) → .cc → IPC → 主进程落盘(Designed_<ts>)`