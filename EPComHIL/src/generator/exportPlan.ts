// W8 导出清单（纯函数，不依赖 node:*）：内容生成的唯一来源。
// 渲染进程、Node 侧落盘、单元测试三方共用同一份清单，避免出现第二套实现。
import type { ProjectConfig } from '../core/types';
import type { ValidationResult } from '../core/Validator';

/** 单个产物：relPath 为相对工程根的 POSIX 路径 */
export interface ExportFile {
  relPath: string;
  content: string;
}

/**
 * 产物面向的 ns-3 版本 —— **单一来源**。
 * CMake 骨架注释与 README 的构建/运行说明都引用它，避免「两处版本串只改到一处」
 * 的半更新状态（这类漏改在审查时极易滑过，且会直接误导 Linux 侧的环境选择）。
 * 目标平台为 ns-3.38：CMake + Ninja 构建，Waf 已移除；`./ns3` 包装脚本可用。
 */
export const NS3_TARGET_VERSION = '3.38';

export interface ExportPlan {
  rootName: string;
  files: ExportFile[];
}

/** 目录时间戳（ISO，剔除 Windows 路径非法字符） */
export function exportTimestamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** 场景名安全化：仅保留字母数字下划线与短横 */
export function safeScenarioName(project: ProjectConfig): string {
  return (project.projectName || 'epcomhil').replace(/[^\w-]/g, '_');
}

/**
 * 导出工程：
 * Designed_<ts>/
 *   simulation/<scenario>.cc   ← 自包含 ns-3 脚本
 *   project.json               ← JSON 中间态（附录 C）
 *   validation.json            ← 校验报告
 *   build/CMakeLists.txt       ← 便于二次接入 ns-3 构建的骨架
 *   README.md                  ← 构建/运行说明
 */
export function planExport(
  project: ProjectConfig,
  cpp: string,
  validation: ValidationResult,
  now: Date = new Date(),
): ExportPlan {
  const scenario = safeScenarioName(project);
  return {
    rootName: `Designed_${exportTimestamp(now)}`,
    files: [
      { relPath: `simulation/${scenario}.cc`, content: cpp },
      { relPath: 'project.json', content: JSON.stringify(project, null, 2) },
      { relPath: 'validation.json', content: JSON.stringify(validation, null, 2) },
      { relPath: 'build/CMakeLists.txt', content: toCmake(`../simulation/${scenario}.cc`) },
      { relPath: 'README.md', content: toReadme(project, scenario, validation) },
    ],
  };
}

function toCmake(srcRelative: string): string {
  return [
    'cmake_minimum_required(VERSION 3.16)',
    'project(epcomhil)',
    '',
    'find_package(ns3 REQUIRED)',
    `target_sources(app PRIVATE ${srcRelative.replace(/\\/g, '/')})`,
    '',
    '# 说明：此 CMakeLists 为接入 ns-3 官方构建的骨架，',
    `#      实际请放入 ns-${NS3_TARGET_VERSION} scratch/ 或通过 ns3 命令启用（ns-${NS3_TARGET_VERSION} 为 CMake 构建，已弃用 Waf）。`,
    '',
  ].join('\n');
}

function toReadme(project: ProjectConfig, scenario: string, validation: ValidationResult): string {
  return [
    `# EPComHIL 导出工程 · ${scenario}`,
    '',
    `- 生成时间: ${project.createdAt ?? '-'}`,
    `- 模式: ${project.run.mode} · 时钟源: ${project.run.clockSource}`,
    `- 节点: ${project.nodes.length} · 链路: ${project.links.length} · 协议: ${project.protocols.length} · 业务流: ${project.flows.length}`,
    `- 校验: ${validation.ok ? '通过' : '存在错误'}（errors=${validation.errors.length} warnings=${validation.warnings.length}）`,
    '',
    '## 构建与运行',
    '```bash',
    `# 放入 ns-${NS3_TARGET_VERSION} 环境`,
    `cp simulation/${scenario}.cc $NS3/scratch/`,
    `cd $NS3 && ./ns3 build "${scenario}"`,
    `./ns3 run "${scenario}"`,
    '```',
    '',
    '- 注意：`./ns3` 会**拒绝以 root 身份运行**（`Refusing to run as root`），上述构建与运行',
    '  请用**普通用户**执行。`scratch/*.cc` 由 ns-3 自动发现并纳入构建，无需手改 `CMakeLists.txt`。',
    '',
    '## 命令行参数',
    '- `--precise=true|false`：**导出时固化项**。产物头部的采集说明注释（rough / precise）在生成时',
    '  就已写死，运行期改这个参数不会改变它；采样节流本身由 HIL 引擎落地，先行版产物中无消费方，',
    '  故该参数当前为占位（产物内的参数说明亦已标注）。',
    '- `--hil=true`：**仅对 HIL 模式导出的产物有效**；OFFLINE 产物中没有任何消费 hil 的分支，',
    '  传入会被直接拒绝并以退出码 2 结束（避免误以为在跑半实物闭环）。',
    '',
    '## 结构',
    '```',
    'simulation/      自包含 ns-3 脚本',
    'project.json     JSON 中间态(附录 C)',
    'validation.json  校验报告',
    'build/           CMake 骨架',
    '```',
    '',
  ].join('\n');
}
