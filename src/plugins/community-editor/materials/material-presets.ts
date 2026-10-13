// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * materials/material-presets — the industrial material library of the community
 * editor: flat PBR values (`MaterialValue`) grouped by category, plus the user's
 * own presets persisted in `localStorage`.
 *
 * Imported CAD arrives with every material at metalness 1 / roughness 1 — flat
 * grey. These presets are the quick way out: pick the one closest in hue and
 * material class (`web_editor_materialize`, the Materials window). Values are
 * deliberately plain JSON with no texture maps, so a material op replays from a
 * draft. RAL colours are close sRGB approximations, not colour-matched
 * standards — treat them as a visual aid, not a specification.
 */

import type { MaterialValue } from '../../../core/editor/rv-asset-ops';

/** A selectable material: the PBR value plus its library identity. */
export interface MaterialPreset extends MaterialValue {
  /** Stable id (`steel`, `ral-5015`, `lamp-red`); what `presetId` refers to. */
  id: string;
  category: string;
}

/** Display order of the built-in categories. Custom presets follow in their own group. */
export const PRESET_CATEGORIES: readonly string[] = [
  'Metal', 'Plastic', 'Rubber & Glass', 'Paint (RAL)', 'Lamp / Signal',
];

/** Category label of the user's own presets. */
export const CUSTOM_PRESET_CATEGORY = 'Custom';

/** `localStorage` key of the user's presets (documented in doc-webviewer.md). */
export const CUSTOM_PRESETS_STORAGE_KEY = 'rv-editor-material-presets';

function opaque(
  id: string, name: string, category: string, color: string, metalness: number, roughness: number,
): MaterialPreset {
  return { id, name, category, color, metalness, roughness, opacity: 1, transparent: false };
}

function translucent(
  id: string, name: string, category: string, color: string, metalness: number, roughness: number,
  opacity: number,
): MaterialPreset {
  return { id, name, category, color, metalness, roughness, opacity, transparent: true };
}

/** A lamp: a coloured body that glows. Blue and white get a stronger boost —
 *  bloom is luminance-based and those two read dimmer at equal intensity. */
function lamp(id: string, name: string, color: string, emissive: string, emissiveIntensity: number): MaterialPreset {
  return {
    id, name, category: 'Lamp / Signal', color, metalness: 0, roughness: 0.35,
    opacity: 1, transparent: false, emissive, emissiveIntensity,
  };
}

/** The built-in presets. Frozen: callers copy, never mutate. */
export const BUILTIN_MATERIAL_PRESETS: readonly MaterialPreset[] = Object.freeze([
  // Metal
  opaque('steel', 'Steel', 'Metal', '#9aa0a6', 0.9, 0.4),
  opaque('brushed-alu', 'Brushed Aluminium', 'Metal', '#c4c8cc', 0.95, 0.45),
  opaque('stainless', 'Stainless Steel', 'Metal', '#b9bdc1', 1, 0.3),
  opaque('anodized', 'Anodized Aluminium', 'Metal', '#6f7479', 0.85, 0.5),
  opaque('galvanized', 'Galvanized Steel', 'Metal', '#a9afb3', 0.8, 0.55),
  opaque('cast-iron', 'Cast Iron', 'Metal', '#4a4d50', 0.7, 0.65),
  opaque('brass', 'Brass', 'Metal', '#b5a642', 1, 0.35),
  opaque('copper', 'Copper', 'Metal', '#b87333', 1, 0.35),

  // Plastic
  opaque('plastic-black', 'Plastic Black', 'Plastic', '#1b1c1e', 0, 0.45),
  opaque('plastic-white', 'Plastic White', 'Plastic', '#e9e9e6', 0, 0.45),
  opaque('plastic-grey', 'Plastic Grey', 'Plastic', '#8a8d90', 0, 0.5),
  opaque('plastic-blue', 'Plastic Blue', 'Plastic', '#1f5fa8', 0, 0.45),
  opaque('plastic-red', 'Plastic Red', 'Plastic', '#b3201d', 0, 0.45),
  opaque('plastic-green', 'Plastic Green', 'Plastic', '#2f7d3b', 0, 0.45),
  opaque('plastic-yellow', 'Plastic Yellow', 'Plastic', '#d6b61a', 0, 0.45),

  // Rubber & Glass
  opaque('rubber', 'Rubber', 'Rubber & Glass', '#222325', 0, 0.9),
  translucent('glass', 'Glass', 'Rubber & Glass', '#cfe6ee', 0, 0.05, 0.25),
  translucent('guard', 'Guard (clear panel)', 'Rubber & Glass', '#9fc4d4', 0, 0.1, 0.18),

  // Paint (RAL) — approximate sRGB
  opaque('ral-9005', 'RAL 9005 Jet Black', 'Paint (RAL)', '#0e0e10', 0, 0.5),
  opaque('ral-9010', 'RAL 9010 Pure White', 'Paint (RAL)', '#f1efe6', 0, 0.5),
  opaque('ral-7035', 'RAL 7035 Light Grey', 'Paint (RAL)', '#cbd0cc', 0, 0.5),
  opaque('ral-7016', 'RAL 7016 Anthracite Grey', 'Paint (RAL)', '#293133', 0, 0.5),
  opaque('ral-5015', 'RAL 5015 Sky Blue', 'Paint (RAL)', '#2271b3', 0, 0.5),
  opaque('ral-5010', 'RAL 5010 Gentian Blue', 'Paint (RAL)', '#004f8c', 0, 0.5),
  opaque('ral-3020', 'RAL 3020 Traffic Red', 'Paint (RAL)', '#cc0605', 0, 0.5),
  opaque('ral-2004', 'RAL 2004 Pure Orange', 'Paint (RAL)', '#e75b12', 0, 0.5),
  opaque('ral-1021', 'RAL 1021 Rape Yellow', 'Paint (RAL)', '#f3da0b', 0, 0.5),
  opaque('ral-6018', 'RAL 6018 Yellow Green', 'Paint (RAL)', '#4f9d2d', 0, 0.5),

  // Lamp / Signal — standard signal-tower colours, display order red→white
  lamp('lamp-red', 'Signal Red', '#ff2a1f', '#ff2a1f', 2),
  lamp('lamp-amber', 'Signal Amber', '#ffb000', '#ffb000', 2),
  lamp('lamp-green', 'Signal Green', '#1fdc4a', '#1fdc4a', 2),
  lamp('lamp-blue', 'Signal Blue', '#2f6bff', '#2f6bff', 3.5),
  lamp('lamp-white', 'Signal White', '#fff6e5', '#fff6e5', 3),
]);

/** A custom preset as stored: tolerant parse, anything malformed is dropped. */
function parseCustomPreset(raw: unknown): MaterialPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
  if (typeof r['id'] !== 'string' || !r['id'] || typeof r['color'] !== 'string'
      || !/^#[0-9a-fA-F]{6}$/.test(r['color'])) return null;
  const opacity = Math.min(1, Math.max(0, num(r['opacity'], 1)));
  const preset: MaterialPreset = {
    id: r['id'],
    name: typeof r['name'] === 'string' && r['name'] ? r['name'] : r['id'],
    category: CUSTOM_PRESET_CATEGORY,
    color: r['color'],
    metalness: Math.min(1, Math.max(0, num(r['metalness'], 0))),
    roughness: Math.min(1, Math.max(0, num(r['roughness'], 0.5))),
    opacity,
    transparent: r['transparent'] === true || opacity < 1,
  };
  if (typeof r['emissive'] === 'string' && /^#[0-9a-fA-F]{6}$/.test(r['emissive'])) {
    preset.emissive = r['emissive'];
    preset.emissiveIntensity = num(r['emissiveIntensity'], 1);
  }
  return preset;
}

/** The user's own presets from `localStorage` ([] when absent, unreadable or malformed). */
export function loadCustomPresets(): MaterialPreset[] {
  try {
    const raw = globalThis.localStorage?.getItem(CUSTOM_PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseCustomPreset).filter((p): p is MaterialPreset => p !== null);
  } catch {
    return [];
  }
}

/** Persist the user's presets (the whole list). Returns false when storage refused. */
export function saveCustomPresets(presets: readonly MaterialPreset[]): boolean {
  try {
    globalThis.localStorage?.setItem(CUSTOM_PRESETS_STORAGE_KEY, JSON.stringify(presets));
    return true;
  } catch {
    return false;
  }
}

/** Mix `hex` toward white (`t` > 0) or black (`t` < 0), t in [-1, 1]. */
function shade(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number): number => Math.round(t >= 0 ? c + (255 - c) * t : c * (1 + t));
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/**
 * CSS `background` for a preset swatch: a diagonal sheen over the base colour
 * (stronger for metals), and — for emissive presets — a glowing radial layer on
 * top, so a lamp reads as lit rather than as a coloured square.
 */
export function swatchBackground(preset: MaterialValue): string {
  const sheen = 0.18 + 0.3 * preset.metalness;
  const base = `linear-gradient(135deg, ${shade(preset.color, sheen)} 0%, ${preset.color} 52%, ${shade(preset.color, -0.35)} 100%)`;
  if (!preset.emissive) return base;
  return `radial-gradient(circle at 50% 45%, ${preset.emissive} 0%, ${preset.emissive}99 34%, transparent 74%), ${base}`;
}
