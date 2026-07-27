import {
  Camera,
  CameraOff,
  ImagePlus,
  Mic,
  Send,
  Square,
} from "lucide-react";
import {
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import type { VoiceState } from "@/home/voice/use-voice-conversation";

export function StudentInputDock({
  voiceState,
  cameraActive,
  voiceDisabled,
  sendDisabled,
  onMic,
  onToggleCamera,
  onSendText,
  onSendImage,
}: {
  voiceState: VoiceState;
  cameraActive: boolean;
  voiceDisabled?: boolean;
  sendDisabled?: boolean;
  onMic: () => void;
  onToggleCamera: () => void;
  onSendText: (text: string) => Promise<void> | void;
  onSendImage: (file: File) => Promise<void> | void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || sendDisabled || sending) return;
    setSending(true);
    try {
      await onSendText(value);
      setText("");
    } finally {
      setSending(false);
    }
  };

  const selectImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || sendDisabled || sending) return;
    setSending(true);
    try {
      await onSendImage(file);
    } finally {
      setSending(false);
    }
  };

  const busy = voiceState === "thinking" || voiceState === "speaking";

  return (
    <form className="learning-input-dock" onSubmit={(event) => void submit(event)}>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(event) => void selectImage(event)}
      />
      <button
        type="button"
        className="learning-input-button"
        onClick={() => fileRef.current?.click()}
        aria-label="上传题目图片"
        disabled={sendDisabled || sending}
      >
        <ImagePlus size={19} />
      </button>
      <button
        type="button"
        className={`learning-input-button ${cameraActive ? "is-active" : ""}`}
        onClick={onToggleCamera}
        aria-label={cameraActive ? "关闭摄像头" : "打开摄像头"}
        disabled={voiceDisabled}
      >
        {cameraActive ? <Camera size={19} /> : <CameraOff size={19} />}
      </button>
      <button
        type="button"
        className={`learning-mic-button is-${voiceState}`}
        onClick={onMic}
        aria-label={busy ? "打断 Octos" : "语音提问"}
        disabled={voiceDisabled}
      >
        {busy ? <Square size={16} /> : <Mic size={21} />}
      </button>
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="问一个问题，或告诉 Octos 你卡在哪里…"
        aria-label="输入学习问题"
        disabled={sendDisabled || sending}
      />
      <button
        type="submit"
        className="learning-send-button"
        aria-label="发送问题"
        disabled={sendDisabled || sending || text.trim().length === 0}
      >
        <Send size={18} />
      </button>
    </form>
  );
}
