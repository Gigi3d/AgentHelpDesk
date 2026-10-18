import { useEffect, useState } from 'react';

/**
 * The demo runs on a fixed clock so fixture times read naturally: the page
 * loads at Sat Oct 17, 8:20 p.m. PT (03:20Z on the 18th) and ticks forward
 * in real time from there. Live mode (VITE_LIVE=1) uses the real clock,
 * because live cases carry real timestamps.
 */
const LOADED = Date.now();
const BASE = import.meta.env.VITE_LIVE === '1' ? LOADED : Date.parse('2026-10-18T03:20:00Z');

export const now = () => BASE + (Date.now() - LOADED);

export function useNow(intervalMs = 1000) {
  const [t, setT] = useState(now);
  useEffect(() => {
    const id = setInterval(() => setT(now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return t;
}

const ms = (v: string | number) => (typeof v === 'number' ? v : Date.parse(v));

export const TZ = 'America/Los_Angeles';

const ptDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const ptHourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false });

/** The Pacific calendar day a timestamp falls on, plus a UTC-normalised date for weekday math. */
export function ptDay(v: string | number) {
  const [y, m, d] = ptDayFmt.format(new Date(ms(v))).split('-').map(Number);
  return { y, m, d, date: new Date(Date.UTC(y, m - 1, d)) };
}

export const ptHour = (v: string | number) => Number(ptHourFmt.format(new Date(ms(v))));

export function ago(v: string | number, at = now()) {
  const s = Math.max(0, Math.round((at - ms(v)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "in 42m", "3m late". */
export function until(v: string | number, at = now()) {
  const s = Math.round((ms(v) - at) / 1000);
  const abs = Math.abs(s);
  const txt = abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.floor(abs / 60)}m ${String(abs % 60).padStart(2, '0')}s` : `${Math.floor(abs / 3600)}h ${Math.floor((abs % 3600) / 60)}m`;
  return s >= 0 ? `in ${txt}` : `${txt} late`;
}

export function clock(v: string | number) {
  return new Date(ms(v)).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'America/Los_Angeles' });
}

export function dur(msv: number) {
  if (msv < 1000) return `${msv} ms`;
  if (msv < 60000) return `${(msv / 1000).toFixed(msv < 10000 ? 1 : 0)} s`;
  return `${Math.floor(msv / 60000)}m ${Math.round((msv % 60000) / 1000)}s`;
}

export const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
