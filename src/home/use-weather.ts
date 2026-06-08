/**
 * Weather hook — fetches current weather from Open-Meteo.
 *
 * Uses the browser Geolocation API to get lat/lon, then hits the
 * Open-Meteo free API (no key needed). Refreshes every 15 minutes.
 * Falls back to a null state if geolocation is unavailable.
 */

import { useState, useEffect, useRef } from "react";
import { WMO_WEATHER } from "./constants";

export interface WeatherState {
  temperature: number;
  weatherCode: number;
  emoji: string;
  label: string;
  loading: boolean;
  error: string | null;
}

const REFRESH_INTERVAL = 15 * 60 * 1000; // 15 min

async function fetchWeather(
  lat: number,
  lon: number,
): Promise<{ temperature: number; weatherCode: number }> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as {
    current: { temperature_2m: number; weather_code: number };
  };
  return {
    temperature: Math.round(data.current.temperature_2m),
    weatherCode: data.current.weather_code,
  };
}

export function useWeather(): WeatherState {
  const [state, setState] = useState<WeatherState>({
    temperature: 0,
    weatherCode: 0,
    emoji: "",
    label: "",
    loading: true,
    error: null,
  });
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const coordsRef = useRef<{ lat: number; lon: number } | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load(lat: number, lon: number) {
      try {
        const w = await fetchWeather(lat, lon);
        if (cancelled) return;
        const wmo = WMO_WEATHER[w.weatherCode] ?? {
          emoji: "\u2600\uFE0F",
          label: "Unknown",
        };
        setState({
          temperature: w.temperature,
          weatherCode: w.weatherCode,
          emoji: wmo.emoji,
          label: wmo.label,
          loading: false,
          error: null,
        });
      } catch (err) {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : "fetch failed",
        }));
      }
    }

    function onPosition(pos: GeolocationPosition) {
      if (cancelled) return;
      const { latitude, longitude } = pos.coords;
      coordsRef.current = { lat: latitude, lon: longitude };
      void load(latitude, longitude);
    }

    function onError() {
      if (cancelled) return;
      setState((prev) => ({
        ...prev,
        loading: false,
        error: "geolocation_denied",
      }));
    }

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(onPosition, onError, {
        timeout: 10000,
        maximumAge: 5 * 60 * 1000,
      });
    } else {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: "geolocation_unsupported",
      }));
    }

    timerRef.current = setInterval(() => {
      if (coordsRef.current) {
        void load(coordsRef.current.lat, coordsRef.current.lon);
      }
    }, REFRESH_INTERVAL);

    return () => {
      cancelled = true;
      clearInterval(timerRef.current);
    };
  }, []);

  return state;
}
