import {
  AirVent,
  Camera,
  CirclePower,
  Home,
  Minus,
  Monitor,
  Plus,
  Radio,
  RefreshCw,
  Square,
  Thermometer,
  Volume2,
  Wifi,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, ReactNode } from "react";

import { useHomeSettings } from "./home-settings-context";

type DeviceKind =
  | "camera"
  | "climate"
  | "cover"
  | "network"
  | "sensor"
  | "speaker"
  | "tv";

interface SmartHomeDevice {
  id: string;
  name: string;
  home?: string;
  room?: string;
  kind: DeviceKind | string;
  on: boolean;
  online?: boolean;
  readonly?: boolean;
  brightness?: number;
  volume?: number;
  temperature?: number;
  humidity?: number;
  position?: number;
  color?: string;
  speed?: number;
  mode?: string;
  note?: string;
  muted?: boolean;
  stream?: string;
  stream_capable?: boolean;
  stream_protocol?: string;
}

interface SmartHomeResponse {
  source?: string;
  devices?: SmartHomeDevice[];
  ok?: boolean;
  error?: string;
}

interface CameraStreamInfo {
  ok?: boolean;
  protocol?: string;
  playback_url?: string;
  stream_url?: string;
  error?: string;
}

interface SmartHomeLabels {
  title: string;
  subtitle: string;
  refresh: string;
  loading: string;
  offline: string;
  online: string;
  unavailable: string;
  devices: string;
  controllable: string;
  cameras: string;
  fanSpeed: string;
  modeAuto: string;
  modeCool: string;
  modeDry: string;
  modeFan: string;
  modeHeat: string;
  playPause: string;
  power: string;
  open: string;
  close: string;
  stop: string;
  tempDown: string;
  tempUp: string;
  volumeDown: string;
  volumeUp: string;
  home: string;
  back: string;
  ok: string;
  wake: string;
  music: string;
  radio: string;
  say: string;
  startCamera: string;
  stopCamera: string;
  readOnly: string;
}

const SMART_HOME_API_BASE =
  (import.meta.env.VITE_SMART_HOME_API_BASE as string | undefined)?.replace(/\/$/, "") ||
  "/smart-home-api";
const POLL_MS = 4000;
const REQUEST_TIMEOUT_MS = 3500;

const LABELS: Record<"en" | "zh", SmartHomeLabels> = {
  en: {
    title: "Smart Home",
    subtitle: "Home Assistant bridge",
    refresh: "Refresh",
    loading: "Loading devices",
    offline: "Bridge offline",
    online: "Online",
    unavailable: "Unavailable",
    devices: "Devices",
    controllable: "Actions",
    cameras: "Cameras",
    fanSpeed: "Fan",
    modeAuto: "Auto",
    modeCool: "Cool",
    modeDry: "Dry",
    modeFan: "Fan",
    modeHeat: "Heat",
    playPause: "Play",
    power: "Power",
    open: "Open",
    close: "Close",
    stop: "Stop",
    tempDown: "Cooler",
    tempUp: "Warmer",
    volumeDown: "Vol -",
    volumeUp: "Vol +",
    home: "Home",
    back: "Back",
    ok: "OK",
    wake: "Wake",
    music: "Music",
    radio: "Radio",
    say: "Say",
    startCamera: "Live",
    stopCamera: "Stop",
    readOnly: "Read only",
  },
  zh: {
    title: "\u667A\u80FD\u5BB6\u5C45",
    subtitle: "Home Assistant \u6865\u63A5",
    refresh: "\u5237\u65B0",
    loading: "\u6B63\u5728\u8BFB\u53D6\u8BBE\u5907",
    offline: "\u6865\u63A5\u79BB\u7EBF",
    online: "\u5728\u7EBF",
    unavailable: "\u4E0D\u53EF\u7528",
    devices: "\u8BBE\u5907",
    controllable: "\u52A8\u4F5C",
    cameras: "\u6444\u50CF\u5934",
    fanSpeed: "\u98CE\u91CF",
    modeAuto: "\u81EA\u52A8",
    modeCool: "\u5236\u51B7",
    modeDry: "\u9664\u6E7F",
    modeFan: "\u9001\u98CE",
    modeHeat: "\u5236\u70ED",
    playPause: "\u64AD\u653E",
    power: "\u7535\u6E90",
    open: "\u6253\u5F00",
    close: "\u5173\u95ED",
    stop: "\u505C\u6B62",
    tempDown: "\u964D\u6E29",
    tempUp: "\u5347\u6E29",
    volumeDown: "\u97F3\u91CF-",
    volumeUp: "\u97F3\u91CF+",
    home: "\u4E3B\u9875",
    back: "\u8FD4\u56DE",
    ok: "\u786E\u8BA4",
    wake: "\u5524\u9192",
    music: "\u97F3\u4E50",
    radio: "\u7535\u53F0",
    say: "\u64AD\u62A5",
    startCamera: "\u76F4\u64AD",
    stopCamera: "\u505C\u6B62",
    readOnly: "\u53EA\u8BFB",
  },
};

function apiPath(path: string): string {
  return `${SMART_HOME_API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function postBody(params: Record<string, string | number | boolean>): URLSearchParams {
  const body = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => body.set(key, String(value)));
  return body;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      ...init,
      signal: controller.signal,
    });
    const data = (await response.json().catch(() => ({}))) as T;
    if (!response.ok) {
      const error = data && typeof data === "object" && "error" in data
        ? String((data as { error?: unknown }).error)
        : `HTTP ${response.status}`;
      throw new Error(error);
    }
    return data;
  } finally {
    window.clearTimeout(timer);
  }
}

function useSmartHomeDevices() {
  const [devices, setDevices] = useState<SmartHomeDevice[]>([]);
  const [source, setSource] = useState("home_assistant");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [cameraStreams, setCameraStreams] = useState<Record<string, CameraStreamInfo>>({});
  const aliveRef = useRef(true);

  const loadDevices = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await fetchJson<SmartHomeResponse>(apiPath("/devices"));
      if (!aliveRef.current) return;
      setDevices(Array.isArray(data.devices) ? data.devices : []);
      setSource(data.source ?? "home_assistant");
      setError(data.ok === false ? data.error ?? "Bridge error" : null);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : "Bridge error");
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void loadDevices();
    const timer = window.setInterval(() => void loadDevices(true), POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
    };
  }, [loadDevices]);

  const updateDevice = useCallback(
    async (id: string, params: Record<string, string | number | boolean>) => {
      setActionId(id);
      try {
        await fetchJson(apiPath(`/devices/${encodeURIComponent(id)}`), {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: postBody(params),
        });
        setError(null);
        await loadDevices(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Bridge action failed");
      } finally {
        setActionId(null);
      }
    },
    [loadDevices],
  );

  const startCamera = useCallback(async (id: string) => {
    setActionId(id);
    try {
      const data = await fetchJson<CameraStreamInfo>(
        apiPath(`/cameras/${encodeURIComponent(id)}/stream`),
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: postBody({ quality: 2 }),
        },
      );
      setCameraStreams((prev) => ({ ...prev, [id]: data }));
      setError(null);
      await loadDevices(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Camera stream failed");
    } finally {
      setActionId(null);
    }
  }, [loadDevices]);

  const stopCamera = useCallback(async (id: string) => {
    setActionId(id);
    try {
      await fetchJson(apiPath(`/cameras/${encodeURIComponent(id)}/stop`), {
        method: "POST",
      });
      setCameraStreams((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setError(null);
      await loadDevices(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Camera stop failed");
    } finally {
      setActionId(null);
    }
  }, [loadDevices]);

  return {
    actionId,
    cameraStreams,
    devices,
    error,
    loading,
    loadDevices,
    source,
    startCamera,
    stopCamera,
    updateDevice,
  };
}

function iconForDevice(kind: string): LucideIcon {
  switch (kind) {
    case "camera":
      return Camera;
    case "climate":
      return AirVent;
    case "network":
      return Wifi;
    case "sensor":
      return Thermometer;
    case "speaker":
      return Radio;
    case "tv":
      return Monitor;
    default:
      return Home;
  }
}

function primaryValue(device: SmartHomeDevice): string {
  switch (device.kind) {
    case "climate":
      return `${Math.round(numberOrZero(device.temperature))}C`;
    case "cover":
      return `${clampPercent(numberOrZero(device.position ?? device.brightness))}%`;
    case "sensor":
      return `${numberOrZero(device.temperature).toFixed(1)}C / ${Math.round(numberOrZero(device.humidity))}%`;
    case "speaker":
    case "tv":
      return `${clampPercent(numberOrZero(device.volume ?? device.brightness))}%`;
    case "camera":
      return device.stream ?? device.mode ?? "";
    default:
      return device.mode ?? "";
  }
}

function deviceMeta(device: SmartHomeDevice): string {
  return [device.home, device.room].filter(Boolean).join(" / ");
}

function hasDeviceActions(device: SmartHomeDevice): boolean {
  return (
    device.kind === "tv" ||
    device.kind === "speaker" ||
    device.kind === "climate" ||
    device.kind === "cover" ||
    (device.kind === "camera" && device.stream_capable === true)
  );
}

function StatusPill({
  device,
  labels,
}: {
  device: SmartHomeDevice;
  labels: SmartHomeLabels;
}) {
  const online = device.online !== false;
  return (
    <span className={`smart-home-status-pill ${online ? "is-online" : "is-offline"}`}>
      {online ? labels.online : labels.unavailable}
    </span>
  );
}

function StatusDot({ device }: { device: SmartHomeDevice }) {
  const online = device.online !== false;
  return (
    <span
      className={`smart-home-status-dot ${online ? "is-online" : "is-offline"}`}
      aria-hidden="true"
    />
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="smart-home-icon-button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function DeviceControls({
  device,
  labels,
  busy,
  stream,
  updateDevice,
  startCamera,
  stopCamera,
}: {
  device: SmartHomeDevice;
  labels: SmartHomeLabels;
  busy: boolean;
  stream?: CameraStreamInfo;
  updateDevice: (id: string, params: Record<string, string | number | boolean>) => Promise<void>;
  startCamera: (id: string) => Promise<void>;
  stopCamera: (id: string) => Promise<void>;
}) {
  const [positionDraft, setPositionDraft] = useState(
    clampPercent(numberOrZero(device.position ?? device.brightness)),
  );

  useEffect(() => {
    setPositionDraft(clampPercent(numberOrZero(device.position ?? device.brightness)));
  }, [device.brightness, device.position]);

  if (device.kind === "climate") {
    const temp = Math.round(numberOrZero(device.temperature || 24));
    const speed = clampPercent(numberOrZero(device.speed));
    const modes = [
      ["cool", labels.modeCool],
      ["heat", labels.modeHeat],
      ["dry", labels.modeDry],
      ["fan", labels.modeFan],
      ["auto", labels.modeAuto],
    ] as const;
    return (
      <div className="smart-home-control-stack">
        <div className="smart-home-controls">
          <IconButton
            label={`${device.name} ${labels.power}`}
            disabled={busy}
            onClick={() => void updateDevice(device.id, { on: !device.on })}
          >
            <CirclePower size={18} />
          </IconButton>
          <IconButton
            label={`${device.name} ${labels.tempDown}`}
            disabled={busy}
            onClick={() => void updateDevice(device.id, { temperature: temp - 1, on: true })}
          >
            <Minus size={18} />
          </IconButton>
          <span className="smart-home-control-readout">{temp}C</span>
          <IconButton
            label={`${device.name} ${labels.tempUp}`}
            disabled={busy}
            onClick={() => void updateDevice(device.id, { temperature: temp + 1, on: true })}
          >
            <Plus size={18} />
          </IconButton>
        </div>
        <label className="smart-home-slider-row">
          <span>{labels.fanSpeed}</span>
          <input
            type="range"
            min={0}
            max={100}
            value={speed}
            disabled={busy}
            aria-label={`${device.name} ${labels.fanSpeed}`}
            onChange={(event) =>
              void updateDevice(device.id, { speed: Number(event.currentTarget.value), on: true })
            }
          />
        </label>
        <div className="smart-home-mode-row">
          {modes.map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              className={`smart-home-mode-button ${
                device.mode === mode || (mode === "fan" && device.mode === "fan_only")
                  ? "is-active"
                  : ""
              }`}
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                void updateDevice(device.id, { mode, on: true });
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (device.kind === "cover") {
    return (
      <div className="smart-home-cover-controls">
        <div className="smart-home-controls">
          <IconButton
            label={`${device.name} ${labels.open}`}
            disabled={busy}
            onClick={() => void updateDevice(device.id, { action: "open" })}
          >
            <Plus size={18} />
          </IconButton>
          <IconButton
            label={`${device.name} ${labels.stop}`}
            disabled={busy}
            onClick={() => void updateDevice(device.id, { action: "stop" })}
          >
            <Square size={15} />
          </IconButton>
          <IconButton
            label={`${device.name} ${labels.close}`}
            disabled={busy}
            onClick={() => void updateDevice(device.id, { action: "close" })}
          >
            <Minus size={18} />
          </IconButton>
        </div>
        <label className="smart-home-slider-row">
          <span>{positionDraft}%</span>
          <input
            type="range"
            min={0}
            max={100}
            value={positionDraft}
            disabled={busy}
            aria-label={`${device.name} position`}
            onChange={(event) => setPositionDraft(Number(event.currentTarget.value))}
            onPointerUp={(event) =>
              void updateDevice(device.id, { position: Number(event.currentTarget.value) })
            }
            onKeyUp={(event) => {
              if (event.key === "Enter") {
                void updateDevice(device.id, { position: positionDraft });
              }
            }}
            onBlur={() => {
              if (positionDraft !== clampPercent(numberOrZero(device.position ?? device.brightness))) {
                void updateDevice(device.id, { position: positionDraft });
              }
            }}
          />
        </label>
      </div>
    );
  }

  if (device.kind === "tv") {
    return (
      <div className="smart-home-controls">
        <IconButton
          label={`${device.name} ${labels.volumeDown}`}
          disabled={busy}
          onClick={() => void updateDevice(device.id, { action: "volume_down" })}
        >
          <Volume2 size={17} />
        </IconButton>
        <IconButton
          label={`${device.name} ${labels.volumeUp}`}
          disabled={busy}
          onClick={() => void updateDevice(device.id, { action: "volume_up" })}
        >
          <Plus size={18} />
        </IconButton>
        <IconButton
          label={`${device.name} ${labels.home}`}
          disabled={busy}
          onClick={() => void updateDevice(device.id, { action: "home" })}
        >
          <Home size={17} />
        </IconButton>
        <IconButton
          label={`${device.name} ${labels.ok}`}
          disabled={busy}
          onClick={() => void updateDevice(device.id, { action: "ok" })}
        >
          <span>OK</span>
        </IconButton>
        <IconButton
          label={`${device.name} ${labels.back}`}
          disabled={busy}
          onClick={() => void updateDevice(device.id, { action: "back" })}
        >
          <span>{labels.back}</span>
        </IconButton>
        <IconButton
          label={`${device.name} ${labels.playPause}`}
          disabled={busy}
          onClick={() => void updateDevice(device.id, { action: "play_pause" })}
        >
          <span>{labels.playPause}</span>
        </IconButton>
      </div>
    );
  }

  if (device.kind === "speaker") {
    return (
      <div className="smart-home-controls">
        <IconButton
          label={`${device.name} ${labels.wake}`}
          disabled={busy}
          onClick={() => void updateDevice(device.id, { action: "wake" })}
        >
          <CirclePower size={17} />
        </IconButton>
        <IconButton
          label={`${device.name} ${labels.music}`}
          disabled={busy}
          onClick={() => void updateDevice(device.id, { action: "music" })}
        >
          <Radio size={17} />
        </IconButton>
        <IconButton
          label={`${device.name} ${labels.radio}`}
          disabled={busy}
          onClick={() => void updateDevice(device.id, { action: "radio" })}
        >
          <Volume2 size={17} />
        </IconButton>
        <IconButton
          label={`${device.name} ${labels.say}`}
          disabled={busy}
          onClick={() => void updateDevice(device.id, { action: "say" })}
        >
          <Volume2 size={17} />
        </IconButton>
      </div>
    );
  }

  if (device.kind === "camera" && device.stream_capable) {
    const activeUrl = stream?.playback_url ?? stream?.stream_url;
    return (
      <div className="smart-home-camera-controls">
        <div className="smart-home-controls">
          <IconButton
            label={`${device.name} ${labels.startCamera}`}
            disabled={busy}
            onClick={() => void startCamera(device.id)}
          >
            <Camera size={17} />
          </IconButton>
          <IconButton
            label={`${device.name} ${labels.stopCamera}`}
            disabled={busy || !stream}
            onClick={() => void stopCamera(device.id)}
          >
            <Square size={15} />
          </IconButton>
        </div>
        {activeUrl && (
          <iframe
            title={device.name}
            src={activeUrl}
            className="smart-home-camera-frame"
            loading="lazy"
          />
        )}
      </div>
    );
  }

  return <div className="smart-home-readonly">{labels.readOnly}</div>;
}

function DeviceCard({
  device,
  labels,
  busy,
  stream,
  updateDevice,
  startCamera,
  stopCamera,
}: {
  device: SmartHomeDevice;
  labels: SmartHomeLabels;
  busy: boolean;
  stream?: CameraStreamInfo;
  updateDevice: (id: string, params: Record<string, string | number | boolean>) => Promise<void>;
  startCamera: (id: string) => Promise<void>;
  stopCamera: (id: string) => Promise<void>;
}) {
  const Icon = iconForDevice(device.kind);
  const accent = device.color || "#7dd3fc";
  return (
    <article
      className={`smart-home-device-card ${device.on ? "is-on" : "is-off"} ${
        device.online === false ? "is-unavailable" : ""
      }`}
      style={{ "--smart-home-accent": accent } as CSSProperties}
    >
      <div className="smart-home-device-top">
        <div className="smart-home-device-icon">
          <Icon size={20} />
        </div>
        <div className="smart-home-device-main">
          <div className="smart-home-device-title-row">
            <h3>{device.name}</h3>
            <StatusPill device={device} labels={labels} />
          </div>
          <div className="smart-home-device-meta">{deviceMeta(device)}</div>
        </div>
        <div className="smart-home-device-value">{primaryValue(device)}</div>
      </div>
      {device.note && <p className="smart-home-device-note">{device.note}</p>}
      <DeviceControls
        device={device}
        labels={labels}
        busy={busy}
        stream={stream}
        updateDevice={updateDevice}
        startCamera={startCamera}
        stopCamera={stopCamera}
      />
    </article>
  );
}

function CompactDeviceCard({
  device,
  onSelect,
}: {
  device: SmartHomeDevice;
  onSelect: (device: SmartHomeDevice) => void;
}) {
  const Icon = iconForDevice(device.kind);
  const accent = device.color || "#7dd3fc";
  return (
    <button
      type="button"
      className={`smart-home-device-card smart-home-device-compact smart-home-device-button ${
        device.on ? "is-on" : "is-off"
      } ${device.online === false ? "is-unavailable" : ""}`}
      style={{ "--smart-home-accent": accent } as CSSProperties}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(device);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.stopPropagation();
          onSelect(device);
        }
      }}
      aria-label={`${device.name} controls`}
    >
      <div className="smart-home-device-top">
        <div className="smart-home-device-icon">
          <Icon size={18} />
        </div>
        <div className="smart-home-device-main">
          <div className="smart-home-device-title-row">
            <h3>{device.name}</h3>
            <StatusDot device={device} />
          </div>
          <div className="smart-home-device-meta">{device.room || device.home || device.kind}</div>
        </div>
        <div className="smart-home-device-value">{primaryValue(device)}</div>
      </div>
    </button>
  );
}

function DeviceDetailPanel({
  device,
  labels,
  busy,
  stream,
  onClose,
  updateDevice,
  startCamera,
  stopCamera,
}: {
  device: SmartHomeDevice;
  labels: SmartHomeLabels;
  busy: boolean;
  stream?: CameraStreamInfo;
  onClose: () => void;
  updateDevice: (id: string, params: Record<string, string | number | boolean>) => Promise<void>;
  startCamera: (id: string) => Promise<void>;
  stopCamera: (id: string) => Promise<void>;
}) {
  const Icon = iconForDevice(device.kind);
  const accent = device.color || "#7dd3fc";
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="smart-home-device-popover-backdrop"
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        className="smart-home-device-popover"
        role="dialog"
        aria-modal="false"
        aria-label={`${device.name} controls`}
        style={{ "--smart-home-accent": accent } as CSSProperties}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="smart-home-device-popover-header">
          <div className="smart-home-device-popover-title">
            <span className="smart-home-device-popover-icon">
              <Icon size={19} />
            </span>
            <div className="min-w-0">
              <h3>{device.name}</h3>
              <p>{device.room || device.home || device.kind}</p>
            </div>
          </div>
          <button
            type="button"
            className="smart-home-device-popover-close"
            aria-label={`${device.name} close controls`}
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
          >
            <X size={18} />
          </button>
        </header>

        <div className="smart-home-device-popover-readout">
          <div>
            <strong>{primaryValue(device) || (device.on ? labels.online : labels.unavailable)}</strong>
            <span>{device.kind}</span>
          </div>
          <div>
            <strong>{device.online === false ? labels.unavailable : labels.online}</strong>
            <span>{device.mode || device.stream || "-"}</span>
          </div>
        </div>

        {device.note && <p className="smart-home-device-popover-note">{device.note}</p>}

        <DeviceControls
          device={device}
          labels={labels}
          busy={busy}
          stream={stream}
          updateDevice={updateDevice}
          startCamera={startCamera}
          stopCamera={stopCamera}
        />
      </div>
    </div>,
    document.body,
  );
}

export function SmartHomePanel({ variant = "metro" }: { variant?: "metro" | "classic" }) {
  const { lang } = useHomeSettings();
  const labels = LABELS[lang];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const {
    actionId,
    cameraStreams,
    devices,
    error,
    loading,
    loadDevices,
    source,
    startCamera,
    stopCamera,
    updateDevice,
  } = useSmartHomeDevices();

  const summary = useMemo(() => {
    const online = devices.filter((device) => device.online !== false).length;
    const controllable = devices.filter(hasDeviceActions).length;
    const cameras = devices.filter((device) => device.kind === "camera").length;
    return { online, controllable, cameras };
  }, [devices]);
  const displayedDevices = useMemo(() => {
    if (variant !== "metro") return devices;
    const kindWeight: Record<string, number> = {
      tv: 0,
      climate: 1,
      cover: 2,
      speaker: 3,
      camera: 4,
      sensor: 5,
      network: 6,
    };
    return [...devices].sort((a, b) => {
      const aWeight = kindWeight[a.kind] ?? 10;
      const bWeight = kindWeight[b.kind] ?? 10;
      return aWeight - bWeight || a.name.localeCompare(b.name);
    });
  }, [devices, variant]);
  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === selectedId) ?? null,
    [devices, selectedId],
  );

  useEffect(() => {
    if (selectedId && !selectedDevice) setSelectedId(null);
  }, [selectedDevice, selectedId]);

  return (
    <section className={`smart-home-panel smart-home-panel-${variant}`} data-testid="smart-home-panel">
      <header className="smart-home-header">
        <div>
          <div className="smart-home-eyebrow">{variant === "metro" ? labels.title : source}</div>
          <h2>{labels.title}</h2>
          <p>
            {error
              ? labels.offline
              : variant === "metro"
                ? `${summary.online}/${devices.length || 0} ${labels.online}`
                : labels.subtitle}
          </p>
        </div>
        <button
          type="button"
          className="smart-home-refresh"
          onClick={(event) => {
            event.stopPropagation();
            void loadDevices();
          }}
          aria-label={labels.refresh}
          title={labels.refresh}
        >
          <RefreshCw size={17} className={loading ? "smart-home-spin" : ""} />
        </button>
      </header>

      {variant === "metro" ? (
        <div className="smart-home-metro-summary" aria-label={`${devices.length} ${labels.devices}`}>
          <span>
            <strong>{devices.length}</strong>
            {labels.devices}
          </span>
          <span>
            <strong>{summary.controllable}</strong>
            {labels.controllable}
          </span>
          <span>
            <strong>{summary.cameras}</strong>
            {labels.cameras}
          </span>
        </div>
      ) : (
        <div className="smart-home-summary">
          <div>
            <strong>{devices.length}</strong>
            <span>{labels.devices}</span>
          </div>
          <div>
            <strong>{summary.online}</strong>
            <span>{labels.online}</span>
          </div>
          <div>
            <strong>{summary.controllable}</strong>
            <span>{labels.controllable}</span>
          </div>
          <div>
            <strong>{summary.cameras}</strong>
            <span>{labels.cameras}</span>
          </div>
        </div>
      )}

      {loading && devices.length === 0 ? (
        <div className="smart-home-empty">{labels.loading}</div>
      ) : error && devices.length === 0 ? (
        <div className="smart-home-empty">{error}</div>
      ) : (
        <div className="smart-home-device-list">
          {displayedDevices.map((device) =>
            variant === "metro" ? (
              <CompactDeviceCard
                key={device.id}
                device={device}
                onSelect={(nextDevice) => setSelectedId(nextDevice.id)}
              />
            ) : (
              <DeviceCard
                key={device.id}
                device={device}
                labels={labels}
                busy={actionId === device.id}
                stream={cameraStreams[device.id]}
                updateDevice={updateDevice}
                startCamera={startCamera}
                stopCamera={stopCamera}
              />
            ),
          )}
        </div>
      )}
      {variant === "metro" && selectedDevice && (
        <DeviceDetailPanel
          device={selectedDevice}
          labels={labels}
          busy={actionId === selectedDevice.id}
          stream={cameraStreams[selectedDevice.id]}
          onClose={() => setSelectedId(null)}
          updateDevice={updateDevice}
          startCamera={startCamera}
          stopCamera={stopCamera}
        />
      )}
    </section>
  );
}
