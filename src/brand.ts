// Agent brand (approved by the owner 2026-10-24): name, ticker, handle, colors — from brand/brand.json (kept by Brand).
// The name is never written in code: everything comes from here. No file — a neutral "AGENT" (tests, old installs).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Brand {
  name: string; ticker: string; handle: string; handleRegistered: boolean;
  colors: Record<string, string>;
  /** Voice for public texts (brand/PERSONA.md), if Brand has delivered it. */
  persona?: string;
}

export function loadBrand(dir = process.env.AGENT_BRAND_DIR ? resolve(process.env.AGENT_BRAND_DIR) : resolve(process.env.AGENT_ROOT ?? process.cwd(), 'brand')): Brand {
  const p = resolve(dir, 'brand.json');
  let j: any = {};
  try { if (existsSync(p)) j = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { console.warn(`brand.json: ${String(e)}`); }
  const personaPath = resolve(dir, 'PERSONA.md');
  return {
    name: typeof j.name === 'string' && j.name ? j.name : 'AGENT',
    ticker: typeof j.ticker === 'string' ? j.ticker : '',
    handle: typeof j.handle === 'string' ? j.handle : '',
    handleRegistered: j.handle_registered === true,
    colors: j.colors && typeof j.colors === 'object' ? j.colors : {},
    persona: existsSync(personaPath) ? readFileSync(personaPath, 'utf8').slice(0, 4000) : undefined,
  };
}

export const BRAND = loadBrand();
