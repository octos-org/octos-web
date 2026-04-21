export function WelcomeScreen() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <img
        src="/images/octos-logo-color.svg"
        alt="Octos"
        className="h-14 w-auto select-none"
      />
      <p className="max-w-md text-muted">
        AI agent powered by octos. Send a message to get started.
      </p>
    </div>
  );
}
