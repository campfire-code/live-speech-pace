// 工具声明：直播语速告警器（自定义界面，麦克风声音只在本机即时计算，不录音、不联网）。
import { Gauge as GaugeAsIcon } from 'lucide-react';
import { createElement } from 'react';
import type { CustomTool } from '../kit/types';
import { Main } from './Main';

const tool: CustomTool = {
  id: 'c33',
  name: '直播语速告警器',
  tagline: '直播时实时测说话快慢，太快就响铃提醒，纯本地不录音',
  icon: GaugeAsIcon,
  category: '内容生产',
  type: 'media',
  mode: 'custom',
  mainLabel: '语速监测',
  params: [],
  Main: () => createElement(Main),
};

export default tool;
