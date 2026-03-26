export function WelcomeScreen() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="text-4xl">MoFa</div>
      <p className="max-w-md text-muted">
        MoFa AI 助手，发送消息开始对话
      </p>
    </div>
  );
}
