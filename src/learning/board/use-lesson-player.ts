import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LessonPacketV1 } from "./lesson-packet";

export interface LessonPlayer {
  segmentIndex: number;
  segmentCount: number;
  activeSpeech: string;
  playing: boolean;
  completed: boolean;
  play: () => void;
  pause: () => void;
  restart: () => void;
  next: () => void;
  previous: () => void;
}

function segmentDuration(speech: string): number {
  return Math.min(6500, Math.max(2800, 1100 + speech.length * 95));
}

export function useLessonPlayer(
  packet: LessonPacketV1,
  autoPlay = false,
): LessonPlayer {
  const packetKey = packet.lessonId;
  const canPlay = packet.segments.length > 0;
  const [state, setState] = useState(() => ({
    packetKey,
    segmentIndex: autoPlay && canPlay ? 0 : -1,
    playing: autoPlay && canPlay,
  }));
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const segmentCountRef = useRef(packet.segments.length);
  const current = useMemo(
    () =>
      state.packetKey === packetKey
        ? state
        : {
            packetKey,
            segmentIndex: autoPlay && canPlay ? 0 : -1,
            playing: autoPlay && canPlay,
          },
    [autoPlay, canPlay, packetKey, state],
  );
  const { segmentIndex, playing } = current;

  const clearTimer = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);

  useEffect(() => {
    clearTimer();
    if (!playing || segmentIndex < 0) return;
    const segment = packet.segments[segmentIndex];
    if (!segment) return;
    timerRef.current = setTimeout(() => {
      if (segmentIndex >= packet.segments.length - 1) {
        setState((value) => ({
          ...(value.packetKey === packetKey ? value : current),
          playing: false,
        }));
        return;
      }
      setState((value) => {
        const next = value.packetKey === packetKey ? value : current;
        return { ...next, segmentIndex: next.segmentIndex + 1 };
      });
    }, segmentDuration(segment.speech));
    return clearTimer;
  }, [
    clearTimer,
    current,
    packet,
    packetKey,
    playing,
    segmentIndex,
  ]);

  useEffect(() => clearTimer, [clearTimer]);

  useEffect(() => {
    const previousCount = segmentCountRef.current;
    segmentCountRef.current = packet.segments.length;
    if (
      state.packetKey !== packetKey ||
      !autoPlay ||
      packet.segments.length <= previousCount
    ) {
      return;
    }
    setState({
      packetKey,
      segmentIndex: previousCount,
      playing: true,
    });
  }, [autoPlay, packet.segments.length, packetKey, state.packetKey]);

  const play = useCallback(() => {
    if (!canPlay) return;
    setState((value) => {
      const next = value.packetKey === packetKey ? value : current;
      return {
        packetKey,
        segmentIndex:
          next.segmentIndex < 0 ||
          next.segmentIndex >= packet.segments.length - 1
            ? 0
            : next.segmentIndex,
        playing: true,
      };
    });
  }, [canPlay, current, packet.segments.length, packetKey]);

  const pause = useCallback(() => {
    clearTimer();
    setState({ ...current, playing: false });
  }, [clearTimer, current]);

  const restart = useCallback(() => {
    clearTimer();
    setState({
      packetKey,
      segmentIndex: canPlay ? 0 : -1,
      playing: canPlay,
    });
  }, [canPlay, clearTimer, packetKey]);

  const next = useCallback(() => {
    if (!canPlay) return;
    clearTimer();
    setState({
      ...current,
      segmentIndex: Math.min(
        packet.segments.length - 1,
        Math.max(0, current.segmentIndex + 1),
      ),
      playing: false,
    });
  }, [canPlay, clearTimer, current, packet.segments.length]);

  const previous = useCallback(() => {
    if (!canPlay) return;
    clearTimer();
    setState({
      ...current,
      segmentIndex: Math.max(0, current.segmentIndex - 1),
      playing: false,
    });
  }, [canPlay, clearTimer, current]);

  return useMemo(
    () => ({
      segmentIndex,
      segmentCount: packet.segments.length,
      activeSpeech:
        segmentIndex >= 0 ? packet.segments[segmentIndex]?.speech ?? "" : "",
      playing,
      completed:
        !playing &&
        segmentIndex === packet.segments.length - 1 &&
        segmentIndex >= 0,
      play,
      pause,
      restart,
      next,
      previous,
    }),
    [
      next,
      packet.segments,
      pause,
      play,
      playing,
      previous,
      restart,
      segmentIndex,
    ],
  );
}
