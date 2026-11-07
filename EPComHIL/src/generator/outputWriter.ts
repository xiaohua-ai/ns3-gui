// W8 输出器（Node 侧）：按导出清单落盘。清单本身是纯函数，见 exportPlan.ts。
// 渲染进程只引 exportPlan（不含 node:*），主进程只按清单写盘，三方不重复实现内容生成。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectConfig } from '../core/types';
import type { ValidationResult } from '../core/Validator';
import { planExport, safeScenarioName, type ExportFile } from './exportPlan';

export {
  planExport,
  exportTimestamp,
  safeScenarioName,
  NS3_TARGET_VERSION,
  type ExportFile,
  type ExportPlan,
} from './exportPlan';

export interface ExportDir {
  root: string;
  mainCpp: string;
  cmakeLists: string;
  readme: string;
}

/** Node 侧落盘（单测与 CLI 场景使用；渲染进程经 IPC 走同一份清单） */
export function writeExport(
  project: ProjectConfig,
  cpp: string,
  validation: ValidationResult,
  baseDir: string,
  now: Date = new Date(),
): ExportDir {
  const plan = planExport(project, cpp, validation, now);
  const root = join(baseDir, plan.rootName);
  writePlan(root, plan.files);
  const scenario = safeScenarioName(project);
  return {
    root,
    mainCpp: join(root, 'simulation', `${scenario}.cc`),
    cmakeLists: join(root, 'build', 'CMakeLists.txt'),
    readme: join(root, 'README.md'),
  };
}

function writePlan(root: string, files: ExportFile[]): void {
  for (const f of files) {
    const abs = join(root, f.relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, 'utf8');
  }
}
