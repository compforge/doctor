type ResumableTerminalInput = Pick<NodeJS.ReadStream, "ref" | "resume">;

/**
 * Ink 退出时会 unref/pause 它持有的 stdin。Bun 的 readline 不会稳定地把同一条
 * 输入流重新激活，因此每个 readline/raw prompt 都在创建监听前显式接管 stdin。
 */
export function prepareTerminalInput(
  input: ResumableTerminalInput = process.stdin,
): void {
  input.ref();
  input.resume();
}
