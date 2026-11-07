// W7 生成总管线：装配 → 上下文 → 校验 → 分节编排 → 注入 （生成/导出 共用入口）
import { DEFAULT_RUN } from '../core/types';
import type { ProjectConfig } from '../core/types';
import type { ValidationResult } from '../core/Validator';
import { buildCatalog } from './catalog';
import { makeContext } from './context';
import { validateProject, mergeIssues } from '../core/Validator';
import { buildSource, type BuildOptions } from './builder';
import { buildHilBlock } from './injectSwitcher';
import { telemetryPeriodMs } from './telemetry';

export interface GenerateResult {
  ok: boolean;
  cpp: string;
  validation: ValidationResult;
  options: BuildOptions;
}

/** 生成自包含 ns-3 脚本。ok=false（存在 error 级校验问题）时 cpp 仍生成供预览，但调用方应阻断导出。 */
export function generate(config: ProjectConfig, overrides: Partial<BuildOptions> = {}): GenerateResult {
  const catalog = buildCatalog(config);
  const elements = [
    ...catalog.nodes,
    ...catalog.links,
    ...catalog.protocols,
    ...catalog.flows,
    ...catalog.faults,
    ...catalog.halfPhysical,
  ];
  // 默认值全部取自**工程的运行设置**（唯一来源，见 types.ts 的 RunConfig）。
  // 调用方要以别的模式生成时通过 overrides 显式覆盖 —— 而不是像以前那样
  // 先偷偷把 config.hil.mode 改掉再传进来（那正是两个副本互相打架的起点）。
  const run = config.run ?? DEFAULT_RUN;
  const options: BuildOptions = {
    mode: run.mode,
    precise: run.precise,
    clockSource: run.clockSource,
    stopSeconds: run.stopSeconds,
    // syncMode 只对 REALTIME 有意义：HIL 是硬件在环，必须硬墙钟极限（仿真净时绝不超过
    // 真实时间），否则会与真实设备失步。这条规整收在生成器里 —— 以前导出页写了一份、
    // 运行通道没写，同一份设置竟能生成出两种产物。
    syncMode: run.mode === 'REALTIME' ? run.syncMode : 'HARD_LIMIT',
    scenarioName: config.projectName || 'epcomhil',
    ...overrides,
  };
  options.hilBlock = buildHilBlock(options);

  const { ctx, includes, ipPlan, ipIssues } = makeContext(
    { nodes: catalog.nodes, links: catalog.links },
    {
      hilEnabled: options.mode === 'HIL',
      stopSeconds: options.stopSeconds,
      // 遥测周期与头部「采集：precise / rough」同源，由 telemetry.ts 单一派生
      telemetryPeriodMs: telemetryPeriodMs(options.precise),
    },
  );
  // IP 规划的问题（网段冲突、地址落在网络号/广播号上…）只有算完整个工程的地址才看得出，
  // 故与逐元素校验合并成同一份结果，由它统一决定能否导出。
  const validation = mergeIssues(validateProject(elements, ctx), ipIssues);

  const cpp = buildSource(catalog, ctx, options, ipPlan, includes);
  return { ok: validation.ok, cpp, validation, options };
}