// Bun 的 text import（import ... with { type: "text" }）在编译期把文件内容
// 打进 binary；TS 需要这条 ambient 声明才认识 .py 模块。
declare module "*.py" {
  const text: string;
  export default text;
}

declare module "*/VERSION" {
  const text: string;
  export default text;
}
