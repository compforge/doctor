// Barrel for the rendering layer.
// 内部组件互相 import 走相对路径；外部（app 层）只通过这里取门面，方便日后真要把
// tui 抽成独立 npm package（甚至换框架，比如换到 pi-tui）时，对外接口稳定。

export { App } from "./App";
export type { HistoryItem } from "./History";
