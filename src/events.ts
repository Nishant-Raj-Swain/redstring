import { EventEmitter } from "node:events";

// Every agent step becomes an event. The CLI prints them; the corkboard UI will subscribe to `bus`.
export type Ev = { t: number; agent: string; type: "phase" | "tool" | "result" | "text" | "error"; [k: string]: unknown };
export const bus = new EventEmitter();
export type Emit = (e: Omit<Ev, "t">) => void;

export function makeEmit(t0: number): Emit {
  return (e) => {
    const ev = { t: Date.now() - t0, ...e } as Ev;
    bus.emit("ev", ev);
    const s = (ev.t / 1000).toFixed(1).padStart(5) + "s";
    const who = String(ev.agent).padEnd(9);
    if (ev.type === "phase") console.log(`\n[${s}] ${ev.message}`);
    else if (ev.type === "tool") console.log(`[${s}] ${who} -> ${ev.name}(${JSON.stringify(ev.input).slice(0, 100)})`);
    else if (ev.type === "result") console.log(`        ${who} <- ${ev.summary}${ev.write ? "  [graph write]" : ""}`);
    else if (ev.type === "error") console.log(`        ${who} !! ${ev.message}`);
    else if (ev.type === "text") console.log(`[${s}] ${who} ${String(ev.text).replace(/\n/g, "\n          ")}`);
  };
}
