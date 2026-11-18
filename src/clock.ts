// Agent clock. Tests use virtual time (flag AGENT_VIRTUAL_TIME=1) to check
// daily limits and time-based exits without waiting. All times are UTC.

export interface Clock {
  now(): number; // UTC milliseconds
  iso(): string;
  utcDay(ts?: number): string; // YYYY-MM-DD
}

export class SystemClock implements Clock {
  now() { return Date.now(); }
  iso() { return new Date(this.now()).toISOString(); }
  utcDay(ts = this.now()) { return new Date(ts).toISOString().slice(0, 10); }
}

export class VirtualClock implements Clock {
  constructor(private t: number = Date.UTC(2026, 9, 22, 0, 0, 0)) {}
  now() { return this.t; }
  iso() { return new Date(this.t).toISOString(); }
  utcDay(ts = this.t) { return new Date(ts).toISOString().slice(0, 10); }
  advance(ms: number) { this.t += ms; }
  set(ts: number) { this.t = ts; }
}
