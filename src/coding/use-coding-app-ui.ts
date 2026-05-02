import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ApprovalDecision,
  type ApprovalRequestedEvent,
  type ApprovalRespondParams,
  type CodingConnectionState,
  type DiffPreviewResult,
  type MessageDeltaEvent,
  type PaneSnapshot,
  type RpcNotification,
  type RpcResponse,
  type TaskOutputDeltaEvent,
  type TaskOutputReadResult,
  type TaskUpdatedEvent,
  UI_METHODS,
  createCodingSessionId,
  createRpcRequest,
  protocolNotificationFromEvent,
  uiProtocolWebSocketUrl,
} from "./app-ui-protocol";
import { getSelectedProfileId } from "@/api/client";

export interface CodingLogEntry {
  id: string;
  kind: "user" | "assistant" | "system" | "error";
  text: string;
}

export interface CodingTask {
  id: string;
  title: string;
  state: string;
  detail?: string;
}

export interface CodingApproval extends ApprovalRequestedEvent {
  local_status?: "pending" | "approved" | "denied";
}

export interface CodingDiffPreview {
  id: string;
  result: DiffPreviewResult;
}

export interface CodingPaneState {
  workspace: NonNullable<PaneSnapshot["workspace"]>["entries"];
  artifacts: NonNullable<PaneSnapshot["artifacts"]>["items"];
  gitStatus: NonNullable<PaneSnapshot["git"]>["status"];
  gitHistory: NonNullable<PaneSnapshot["git"]>["history"];
}

interface PendingRequest {
  method: string;
  taskId?: string;
  previewId?: string;
}

function appendLog(
  entries: CodingLogEntry[],
  entry: Omit<CodingLogEntry, "id">,
): CodingLogEntry[] {
  return [...entries, { ...entry, id: crypto.randomUUID() }].slice(-120);
}

function notificationSessionId(notification: RpcNotification): string | undefined {
  const params = notification.params as { session_id?: unknown } | undefined;
  return typeof params?.session_id === "string" ? params.session_id : undefined;
}

export function useCodingAppUi() {
  const [sessionId] = useState(createCodingSessionId);
  const [connectionState, setConnectionState] =
    useState<CodingConnectionState>("connecting");
  const [logs, setLogs] = useState<CodingLogEntry[]>(() => [
    {
      id: crypto.randomUUID(),
      kind: "system",
      text: "Coding workspace initialized for AppUi/UI Protocol v1.",
    },
  ]);
  const [approvals, setApprovals] = useState<CodingApproval[]>([]);
  const [tasks, setTasks] = useState<CodingTask[]>([]);
  const [turnStatus, setTurnStatus] = useState("idle");
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [panes, setPanes] = useState<CodingPaneState>({
    workspace: [],
    artifacts: [],
    gitStatus: [],
    gitHistory: [],
  });
  const [diffs, setDiffs] = useState<CodingDiffPreview[]>([]);
  const [taskOutputs, setTaskOutputs] = useState<Record<string, string>>({});
  const socketRef = useRef<WebSocket | null>(null);
  const pendingRequestsRef = useRef(new Map<string, PendingRequest>());

  const sendProtocol = useCallback((
    method: string,
    params: unknown,
    pending: Omit<PendingRequest, "method"> = {},
  ) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setLogs((current) =>
        appendLog(current, {
          kind: "error",
          text: `UI Protocol transport is not connected; queued method ${method} locally.`,
        }),
      );
      return null;
    }
    const request = createRpcRequest(method, params);
    pendingRequestsRef.current.set(request.id, { method, ...pending });
    socket.send(JSON.stringify(request));
    return request.id;
  }, []);

  const ingestPanes = useCallback((snapshot?: PaneSnapshot) => {
    if (!snapshot) return;
    setPanes({
      workspace: snapshot.workspace?.entries ?? [],
      artifacts: snapshot.artifacts?.items ?? [],
      gitStatus: snapshot.git?.status ?? [],
      gitHistory: snapshot.git?.history ?? [],
    });
  }, []);

  const appendTaskOutput = useCallback((taskId: string, output: string) => {
    if (!output) return;
    setTaskOutputs((current) => ({
      ...current,
      [taskId]: `${current[taskId] ?? ""}${output}`.slice(-12_000),
    }));
  }, []);

  const requestTaskOutput = useCallback(
    (taskId: string) => {
      sendProtocol(
        UI_METHODS.taskOutputRead,
        { session_id: sessionId, task_id: taskId, limit_bytes: 4000 },
        { taskId },
      );
    },
    [sendProtocol, sessionId],
  );

  const requestDiffPreview = useCallback(
    (previewId: string) => {
      sendProtocol(
        UI_METHODS.diffPreviewGet,
        { session_id: sessionId, preview_id: previewId },
        { previewId },
      );
    },
    [sendProtocol, sessionId],
  );

  const ingestResponse = useCallback(
    (response: RpcResponse) => {
      const pending = pendingRequestsRef.current.get(response.id);
      if (pending) pendingRequestsRef.current.delete(response.id);

      if (response.error) {
        setLogs((current) =>
          appendLog(current, {
            kind: "error",
            text: `${pending?.method ?? "request"} failed: ${response.error?.message}`,
          }),
        );
        return;
      }

      const result = response.result as
        | { opened?: { panes?: PaneSnapshot } }
        | DiffPreviewResult
        | TaskOutputReadResult
        | undefined;

      if (pending?.method === UI_METHODS.sessionOpen || "opened" in (result ?? {})) {
        const opened = (response.result as { opened?: { panes?: PaneSnapshot } })
          ?.opened;
        ingestPanes(opened?.panes);
        return;
      }
      if (
        pending?.method === UI_METHODS.diffPreviewGet ||
        "preview" in (result ?? {})
      ) {
        const result = response.result as DiffPreviewResult;
        const id = result.preview?.preview_id ?? pending?.previewId;
        if (!id) return;
        setDiffs((current) => {
          const next = { id, result };
          const existing = current.findIndex((item) => item.id === id);
          if (existing === -1) return [next, ...current].slice(0, 12);
          return current.map((item, index) => (index === existing ? next : item));
        });
        return;
      }
      if (pending?.method === UI_METHODS.taskOutputRead || "text" in (result ?? {})) {
        const result = response.result as TaskOutputReadResult;
        const taskId = result.task_id ?? pending?.taskId;
        const output = result.output ?? result.text;
        if (taskId && output) appendTaskOutput(taskId, output);
      }
    },
    [appendTaskOutput, ingestPanes],
  );

  const ingestNotification = useCallback(
    (notification: RpcNotification) => {
      const eventSessionId = notificationSessionId(notification);
      if (eventSessionId && eventSessionId !== sessionId) return;

      switch (notification.method) {
        case UI_METHODS.approvalRequested: {
          const approval = notification.params as ApprovalRequestedEvent;
          setApprovals((current) => {
            const existing = current.find(
              (item) => item.approval_id === approval.approval_id,
            );
            if (existing) return current;
            return [{ ...approval, local_status: "pending" }, ...current];
          });
          if (approval.typed_details?.diff?.preview_id) {
            requestDiffPreview(approval.typed_details.diff.preview_id);
          }
          break;
        }
        case UI_METHODS.messageDelta: {
          const params = notification.params as MessageDeltaEvent;
          const text = params.delta ?? params.text ?? params.content;
          if (text) {
            setLogs((current) =>
              appendLog(current, { kind: "assistant", text }),
            );
          }
          break;
        }
        case UI_METHODS.taskUpdated: {
          const params = notification.params as TaskUpdatedEvent;
          const id = params.task_id ?? params.id ?? crypto.randomUUID();
          setTasks((current) => {
            const nextTask = {
              id,
              title: params.title ?? "Coding task",
              state: params.state ?? "running",
              detail: params.runtime_detail ?? params.output_tail,
            };
            const existing = current.findIndex((task) => task.id === id);
            if (existing === -1) return [nextTask, ...current].slice(0, 20);
            return current.map((task, index) =>
              index === existing ? { ...task, ...nextTask } : task,
            );
          });
          if (params.output_tail) appendTaskOutput(id, params.output_tail);
          requestTaskOutput(id);
          break;
        }
        case UI_METHODS.taskOutputDelta: {
          const params = notification.params as TaskOutputDeltaEvent;
          appendTaskOutput(
            params.task_id,
            params.chunk ?? params.output ?? params.text ?? "",
          );
          break;
        }
        case UI_METHODS.turnStarted: {
          const params = notification.params as { turn_id?: string };
          setActiveTurnId(params.turn_id ?? null);
          setTurnStatus("running");
          setLogs((current) =>
            appendLog(current, { kind: "system", text: "turn started" }),
          );
          break;
        }
        case UI_METHODS.turnCompleted:
          setActiveTurnId(null);
          setTurnStatus("completed");
          setLogs((current) =>
            appendLog(current, { kind: "system", text: "turn completed" }),
          );
          break;
        case UI_METHODS.turnError:
          setActiveTurnId(null);
          setTurnStatus("error");
          setLogs((current) =>
            appendLog(current, {
              kind: "error",
              text: "turn error",
            }),
          );
          break;
        case UI_METHODS.warning: {
          const params = notification.params as { message?: string };
          setLogs((current) =>
            appendLog(current, {
              kind: "system",
              text: params.message ?? "warning",
            }),
          );
          break;
        }
      }
    },
    [appendTaskOutput, requestDiffPreview, requestTaskOutput, sessionId],
  );

  useEffect(() => {
    let closedByEffect = false;
    const socket = new WebSocket(uiProtocolWebSocketUrl());
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      setConnectionState("connected");
      const profileId = getSelectedProfileId();
      sendProtocol(UI_METHODS.sessionOpen, {
        session_id: sessionId,
        ...(profileId ? { profile_id: profileId } : {}),
      });
    });
    socket.addEventListener("message", (event) => {
      try {
        const decoded = JSON.parse(String(event.data));
        if (decoded && typeof decoded === "object" && "id" in decoded) {
          ingestResponse(decoded as RpcResponse);
          return;
        }
        const notification = protocolNotificationFromEvent(decoded);
        if (notification) ingestNotification(notification);
      } catch {
        setLogs((current) =>
          appendLog(current, {
            kind: "error",
            text: "Received an invalid UI Protocol frame.",
          }),
        );
      }
    });
    socket.addEventListener("error", () => {
      if (!closedByEffect) setConnectionState("error");
    });
    socket.addEventListener("close", () => {
      if (!closedByEffect) setConnectionState("offline");
    });

    return () => {
      closedByEffect = true;
      socket.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [ingestNotification, ingestResponse, sendProtocol, sessionId]);

  useEffect(() => {
    function onAppUiEvent(event: Event) {
      const detail = (event as CustomEvent).detail;
      const payload =
        detail && typeof detail === "object" && "kind" in detail
          ? (detail as { payload?: unknown }).payload
          : detail;
      if (payload && typeof payload === "object" && "id" in payload) {
        ingestResponse(payload as RpcResponse);
        return;
      }
      const notification = protocolNotificationFromEvent(detail);
      if (notification) ingestNotification(notification);
    }
    window.addEventListener("octos:app-ui:event", onAppUiEvent);
    return () => window.removeEventListener("octos:app-ui:event", onAppUiEvent);
  }, [ingestNotification, ingestResponse]);

  const submitPrompt = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const turnId = crypto.randomUUID();
      setActiveTurnId(turnId);
      setTurnStatus("submitted");
      setLogs((current) => appendLog(current, { kind: "user", text: trimmed }));
      sendProtocol(UI_METHODS.turnStart, {
        session_id: sessionId,
        turn_id: turnId,
        input: [{ kind: "text", text: trimmed }],
      });
    },
    [sendProtocol, sessionId],
  );

  const interruptTurn = useCallback(() => {
    if (!activeTurnId) return;
    sendProtocol(UI_METHODS.turnInterrupt, {
      session_id: sessionId,
      turn_id: activeTurnId,
    });
    setTurnStatus("interrupt requested");
  }, [activeTurnId, sendProtocol, sessionId]);

  const respondApproval = useCallback(
    (
      approval: ApprovalRequestedEvent,
      decision: ApprovalDecision,
      note?: string,
    ) => {
      const params: ApprovalRespondParams = {
        session_id: sessionId,
        approval_id: approval.approval_id,
        decision,
        approval_scope: "request",
        ...(note?.trim() ? { client_note: note.trim() } : {}),
      };
      setApprovals((current) =>
        current.map((item) =>
          item.approval_id === approval.approval_id
            ? {
                ...item,
                local_status: decision === "approve" ? "approved" : "denied",
              }
            : item,
        ),
      );
      sendProtocol(UI_METHODS.approvalRespond, params);
    },
    [sendProtocol, sessionId],
  );

  return useMemo(
    () => ({
      sessionId,
      connectionState,
      turnStatus,
      activeTurnId,
      logs,
      approvals,
      tasks,
      panes,
      diffs,
      taskOutputs,
      submitPrompt,
      interruptTurn,
      respondApproval,
    }),
    [
      activeTurnId,
      approvals,
      connectionState,
      diffs,
      interruptTurn,
      logs,
      panes,
      respondApproval,
      sessionId,
      submitPrompt,
      taskOutputs,
      tasks,
      turnStatus,
    ],
  );
}
