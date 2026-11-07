// 自带案例库的编译期内置数据兜底。
// 目录结构：scenarios/<案例文件夹>/case.tc —— 每个用例一个自己的文件夹。
// 工程文件后缀为 .tc（内容为 JSON 文本），由 renderer 的 projectFile.ts / Electron 主进程共同识别。
// Electron 桌面端优先经 IPC 读取磁盘 scenarios 目录（单一来源）；
// 浏览器/预览环境读不到文件系统，回退到此处 bundled 数据（?raw 保持与磁盘文件逐字符一致）。
import p2pUdp from '../../../scenarios/P2P主从UDP/case.tc?raw';
import p2pChain from '../../../scenarios/P2P串行接入/case.tc?raw';
import csmaBus from '../../../scenarios/CSMA三节点/case.tc?raw';
import csmaBr from '../../../scenarios/CSMA广播/case.tc?raw';
import csmaMc from '../../../scenarios/CSMA组播/case.tc?raw';
import csmaSub from '../../../scenarios/CSMA单子网/case.tc?raw';
import gooseSub from '../../../scenarios/GOOSE组播变电站/case.tc?raw';
import microgrid from '../../../scenarios/微电网分布式能源通信/case.tc?raw';
import hilSub from '../../../scenarios/变电站半实物接入/case.tc?raw';
import realtime from '../../../scenarios/实时响应与时钟同步/case.tc?raw';

export interface BuiltinScene {
  /** 用例文件夹名 */
  folder: string;
  /** 文件夹内工程文件名 */
  name: string;
  content: string;
}

export const BUILTIN_SCENES: BuiltinScene[] = [
  { folder: 'P2P主从UDP', name: 'case.tc', content: p2pUdp },
  { folder: 'P2P串行接入', name: 'case.tc', content: p2pChain },
  { folder: 'CSMA三节点', name: 'case.tc', content: csmaBus },
  { folder: 'CSMA广播', name: 'case.tc', content: csmaBr },
  { folder: 'CSMA组播', name: 'case.tc', content: csmaMc },
  { folder: 'CSMA单子网', name: 'case.tc', content: csmaSub },
  { folder: 'GOOSE组播变电站', name: 'case.tc', content: gooseSub },
  { folder: '微电网分布式能源通信', name: 'case.tc', content: microgrid },
  { folder: '变电站半实物接入', name: 'case.tc', content: hilSub },
  { folder: '实时响应与时钟同步', name: 'case.tc', content: realtime },
];