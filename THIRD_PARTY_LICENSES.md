# 第三方开源组件

本工具使用了以下开源组件，许可证原文见各项目仓库。

| 组件 | 用途 | 许可证 |
|---|---|---|
| [Tauri](https://github.com/tauri-apps/tauri) 及官方插件 | 桌面应用框架 | MIT / Apache-2.0 |
| [React](https://github.com/facebook/react) | 界面 | MIT |
| [Lucide](https://github.com/lucide-icons/lucide) | 图标 | ISC |
| [Vite](https://github.com/vitejs/vite) | 构建 | MIT |

## 参考与移植

检测思路（带通滤波 300～3400 Hz、短时能量包络、局部峰谷检测、噪声基线自适应）移植自用户本人早先的网页版 live-speed-monitor（自有代码，无第三方许可证约束），已改写为不依赖浏览器音频接口的纯函数实现。滤波器系数用公开的 RBJ Audio EQ Cookbook 公式计算。
