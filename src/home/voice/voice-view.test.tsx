import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceView } from "./voice-view";
import type { VoiceConversation } from "./use-voice-conversation";

const conversationMock = vi.hoisted(() => ({
  state: "idle" as VoiceConversation["state"],
  cameraActive: false,
  cameraStream: null as MediaStream | null,
  lastSentFrameUrl: null as string | null,
  generating: false,
  exiting: false,
  visual: null as VoiceConversation["visual"],
  error: null as string | null,
  start: vi.fn(),
  stop: vi.fn(),
  interrupt: vi.fn(),
  toggleCamera: vi.fn(),
  dismissVisual: vi.fn(),
}));
const navigateMock = vi.hoisted(() => vi.fn());
const runtimeMock = vi.hoisted((): {
  label: string;
  tone: "default" | "success" | "warning" | "danger";
  ready: boolean;
  loading: boolean;
  canRepair: boolean;
  state: string;
  refresh: ReturnType<typeof vi.fn>;
} => ({
  label: "Voice engine ready",
  tone: "success",
  ready: true,
  loading: false,
  canRepair: true,
  state: "healthy",
  refresh: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("./use-voice-conversation", () => ({
  useVoiceConversation: () => ({
    state: conversationMock.state,
    lastUserText: "",
    lastAssistantText: "",
    error: conversationMock.error,
    start: conversationMock.start,
    stop: conversationMock.stop,
    interrupt: conversationMock.interrupt,
    cameraActive: conversationMock.cameraActive,
    cameraStream: conversationMock.cameraStream,
    lastSentFrameUrl: conversationMock.lastSentFrameUrl,
    cameraError: null,
    toggleCamera: conversationMock.toggleCamera,
    generating: conversationMock.generating,
    exiting: conversationMock.exiting,
    visual: conversationMock.visual,
    dismissVisual: conversationMock.dismissVisual,
  }),
}));

vi.mock("./voice-orb", () => ({
  VoiceOrb: ({ state }: { state: string }) => (
    <div data-testid="voice-orb-state">{state}</div>
  ),
}));

vi.mock("./voice-selector", () => ({
  VoiceSelector: () => <div data-testid="voice-selector" />,
}));

vi.mock("./camera-preview", () => ({
  CameraPreview: () => <div data-testid="camera-preview" />,
}));

vi.mock("./visual-panel", () => ({
  VisualPanel: () => <div data-testid="visual-panel" />,
}));

vi.mock("./audio-playback", () => ({
  unlockAudio: vi.fn(),
}));

vi.mock("../use-ominix-runtime-summary", () => ({
  useOminixRuntimeSummary: () => runtimeMock,
}));

describe("VoiceView", () => {
  beforeEach(() => {
    cleanup();
    conversationMock.state = "idle";
    conversationMock.cameraActive = false;
    conversationMock.cameraStream = null;
    conversationMock.lastSentFrameUrl = null;
    conversationMock.generating = false;
    conversationMock.exiting = false;
    conversationMock.visual = null;
    conversationMock.error = null;
    conversationMock.start.mockReset();
    conversationMock.stop.mockReset();
    conversationMock.interrupt.mockReset();
    conversationMock.toggleCamera.mockReset();
    conversationMock.dismissVisual.mockReset();
    navigateMock.mockReset();
    runtimeMock.label = "Voice engine ready";
    runtimeMock.tone = "success";
    runtimeMock.ready = true;
    runtimeMock.loading = false;
    runtimeMock.canRepair = true;
    runtimeMock.state = "healthy";
    runtimeMock.refresh.mockReset();
  });

  it("auto-starts microphone capture on mount", () => {
    render(<VoiceView sessionId="voice-test" onBack={vi.fn()} />);

    // Entering the voice view begins listening immediately — no orb tap needed.
    expect(conversationMock.start).toHaveBeenCalledTimes(1);
  });

  it("shows the generating indicator even while a prior visual is docked", () => {
    conversationMock.generating = true;
    conversationMock.visual = { path: "w/old.html", kind: "html" };
    render(<VoiceView sessionId="voice-test" onBack={vi.fn()} />);

    expect(screen.getByText("正在生成视觉内容…")).toBeTruthy();
  });

  it("shows microphone/VAD errors when the voice engine is ready", () => {
    conversationMock.error = "VAD asset unavailable: /vad/silero_vad_legacy.onnx";

    render(<VoiceView sessionId="voice-test" onBack={vi.fn()} />);

    expect(screen.getByRole("alert").textContent).toContain("silero_vad_legacy.onnx");
  });

  it("toggles the camera when the camera button is clicked", () => {
    render(<VoiceView sessionId="voice-test" onBack={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "toggle camera" }));

    expect(conversationMock.toggleCamera).toHaveBeenCalledTimes(1);
  });

  it("shows a starting indicator when the camera is on but the stream isn't ready", () => {
    conversationMock.cameraActive = true;
    conversationMock.cameraStream = null;
    render(<VoiceView sessionId="voice-test" onBack={vi.fn()} />);

    expect(screen.getByText("摄像头开启中…")).toBeTruthy();
    expect(screen.queryByTestId("camera-preview")).toBeNull();
  });

  it("shows the self-preview once the stream is live", () => {
    conversationMock.cameraActive = true;
    conversationMock.cameraStream = {} as MediaStream;
    render(<VoiceView sessionId="voice-test" onBack={vi.fn()} />);

    expect(screen.getByTestId("camera-preview")).toBeTruthy();
    expect(screen.getByText("实时画面")).toBeTruthy();
    // starting indicator gone once the stream is present
    expect(screen.queryByText("摄像头开启中…")).toBeNull();
  });

  it("hides the self-preview when the camera is off", () => {
    conversationMock.cameraActive = false;
    render(<VoiceView sessionId="voice-test" onBack={vi.fn()} />);

    expect(screen.queryByTestId("camera-preview")).toBeNull();
  });

  it("shows the frame sent to the AI when a frame URL is present", () => {
    conversationMock.lastSentFrameUrl = "blob:fake-frame";
    render(<VoiceView sessionId="voice-test" onBack={vi.fn()} />);

    const img = screen.getByAltText("frame sent to AI") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("blob:fake-frame");
    expect(screen.getByText("已发给 AI")).toBeTruthy();
  });

  it("hides the sent-frame thumbnail when there is none", () => {
    conversationMock.lastSentFrameUrl = null;
    render(<VoiceView sessionId="voice-test" onBack={vi.fn()} />);

    expect(screen.queryByAltText("frame sent to AI")).toBeNull();
  });

  it("opens OMiniX settings instead of starting capture when runtime is not ready", () => {
    runtimeMock.label = "Voice engine needs repair";
    runtimeMock.tone = "warning";
    runtimeMock.ready = false;
    runtimeMock.loading = false;
    runtimeMock.canRepair = true;
    runtimeMock.state = "missing_plist";

    render(<VoiceView sessionId="voice-test" onBack={vi.fn()} />);

    expect(screen.getByText("语音引擎未就绪，请先在 Settings 里安装或修复 OMiniX。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "open OMiniX settings" }));

    expect(conversationMock.start).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith("/settings?tab=ominix");
  });
});
