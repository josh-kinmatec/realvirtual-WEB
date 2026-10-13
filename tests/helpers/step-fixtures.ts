// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tiny hand-written STEP (ISO 10303-21, AP214) generator for the STEP import tests.
 *
 * Written from scratch for this repo — no third-party file is embedded. It emits
 * millimetre models with:
 *   - box parts (full B-rep: 8 vertices, 12 edges, 6 planar faces), optionally coloured;
 *   - a cylinder part (curved surface, used to make the tessellation quality observable);
 *   - an assembly of named parts, each placed by a translation, using the standard
 *     NEXT_ASSEMBLY_USAGE_OCCURRENCE + CONTEXT_DEPENDENT_SHAPE_REPRESENTATION structure.
 */

class Writer {
  private _n = 0;
  readonly lines: string[] = [];

  add(entity: string): number {
    this._n += 1;
    this.lines.push(`#${this._n}=${entity};`);
    return this._n;
  }
}

/** STEP REAL literal (always carries a decimal point). */
function r(v: number): string {
  if (Number.isInteger(v)) return `${v}.`;
  return String(v);
}

type Vec = [number, number, number];

function point(w: Writer, p: Vec): number {
  return w.add(`CARTESIAN_POINT('',(${r(p[0])},${r(p[1])},${r(p[2])}))`);
}

function direction(w: Writer, d: Vec): number {
  return w.add(`DIRECTION('',(${r(d[0])},${r(d[1])},${r(d[2])}))`);
}

function axis(w: Writer, origin: Vec, z: Vec, x: Vec): number {
  return w.add(`AXIS2_PLACEMENT_3D('',#${point(w, origin)},#${direction(w, z)},#${direction(w, x)})`);
}

function sub(a: Vec, b: Vec): Vec {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function unit(v: Vec): Vec {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** A closed solid. `solid` is the MANIFOLD_SOLID_BREP entity id. */
interface Solid {
  solid: number;
}

/** Axis-aligned box with its minimum corner at the part origin. */
function emitBox(w: Writer, size: Vec): Solid {
  const [sx, sy, sz] = size;
  // Vertex i: bit0 -> x = sx, bit1 -> y = sy, bit2 -> z = sz.
  const pos = (i: number): Vec => [(i & 1) * sx, ((i >> 1) & 1) * sy, ((i >> 2) & 1) * sz];
  const vertex = Array.from({ length: 8 }, (_, i) => w.add(`VERTEX_POINT('',#${point(w, pos(i))})`));

  // 12 edges, each stored low-index -> high-index (differ in exactly one bit).
  const edgeOf = new Map<string, number>();
  for (let a = 0; a < 8; a++) {
    for (let bit = 0; bit < 3; bit++) {
      const b = a | (1 << bit);
      if (b === a) continue;
      const dir = unit(sub(pos(b), pos(a)));
      const line = w.add(`LINE('',#${point(w, pos(a))},#${w.add(`VECTOR('',#${direction(w, dir)},1.)`)})`);
      edgeOf.set(`${a}-${b}`, w.add(`EDGE_CURVE('',#${vertex[a]},#${vertex[b]},#${line},.T.)`));
    }
  }
  const oriented = (from: number, to: number): number => {
    const forward = from < to;
    const edge = edgeOf.get(forward ? `${from}-${to}` : `${to}-${from}`)!;
    return w.add(`ORIENTED_EDGE('',*,*,#${edge},${forward ? '.T.' : '.F.'})`);
  };

  // Faces: vertices counter-clockwise seen from OUTSIDE, so the plane normal points outward.
  const faces: { ring: number[]; normal: Vec }[] = [
    { ring: [0, 2, 3, 1], normal: [0, 0, -1] },
    { ring: [4, 5, 7, 6], normal: [0, 0, 1] },
    { ring: [0, 1, 5, 4], normal: [0, -1, 0] },
    { ring: [2, 6, 7, 3], normal: [0, 1, 0] },
    { ring: [0, 4, 6, 2], normal: [-1, 0, 0] },
    { ring: [1, 3, 7, 5], normal: [1, 0, 0] },
  ];
  const faceIds = faces.map(({ ring, normal }) => {
    const refDir = unit(sub(pos(ring[1]), pos(ring[0])));
    const plane = w.add(`PLANE('',#${axis(w, pos(ring[0]), normal, refDir)})`);
    const oes = ring.map((v, i) => oriented(v, ring[(i + 1) % ring.length]));
    const loop = w.add(`EDGE_LOOP('',(${oes.map((id) => `#${id}`).join(',')}))`);
    const bound = w.add(`FACE_OUTER_BOUND('',#${loop},.T.)`);
    return w.add(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`);
  });
  const shell = w.add(`CLOSED_SHELL('',(${faceIds.map((id) => `#${id}`).join(',')}))`);
  return { solid: w.add(`MANIFOLD_SOLID_BREP('',#${shell})`) };
}

/** Cylinder about +Z, base circle centred on the part origin. */
function emitCylinder(w: Writer, radius: number, height: number): Solid {
  const origin: Vec = [0, 0, 0];
  const zUp: Vec = [0, 0, 1];
  const xDir: Vec = [1, 0, 0];
  const vBottom = w.add(`VERTEX_POINT('',#${point(w, [radius, 0, 0])})`);
  const vTop = w.add(`VERTEX_POINT('',#${point(w, [radius, 0, height])})`);

  const circleBottom = w.add(`CIRCLE('',#${axis(w, origin, zUp, xDir)},${r(radius)})`);
  const circleTop = w.add(`CIRCLE('',#${axis(w, [0, 0, height], zUp, xDir)},${r(radius)})`);
  const seamLine = w.add(`LINE('',#${point(w, [radius, 0, 0])},#${w.add(`VECTOR('',#${direction(w, zUp)},1.)`)})`);
  const eBottom = w.add(`EDGE_CURVE('',#${vBottom},#${vBottom},#${circleBottom},.T.)`);
  const eTop = w.add(`EDGE_CURVE('',#${vTop},#${vTop},#${circleTop},.T.)`);
  const seam = w.add(`EDGE_CURVE('',#${vBottom},#${vTop},#${seamLine},.T.)`);

  const face = (surface: string, edges: [number, boolean][]): number => {
    const oes = edges.map(([e, fwd]) => w.add(`ORIENTED_EDGE('',*,*,#${e},${fwd ? '.T.' : '.F.'})`));
    const loop = w.add(`EDGE_LOOP('',(${oes.map((id) => `#${id}`).join(',')}))`);
    const bound = w.add(`FACE_OUTER_BOUND('',#${loop},.T.)`);
    return w.add(`ADVANCED_FACE('',(#${bound}),${surface},.T.)`);
  };
  const bottomPlane = w.add(`PLANE('',#${axis(w, origin, [0, 0, -1], xDir)})`);
  const topPlane = w.add(`PLANE('',#${axis(w, [0, 0, height], zUp, xDir)})`);
  const side = w.add(`CYLINDRICAL_SURFACE('',#${axis(w, origin, zUp, xDir)},${r(radius)})`);
  const faces = [
    face(`#${bottomPlane}`, [[eBottom, false]]),
    face(`#${topPlane}`, [[eTop, true]]),
    face(`#${side}`, [[eBottom, true], [seam, true], [eTop, false], [seam, false]]),
  ];
  const shell = w.add(`CLOSED_SHELL('',(${faces.map((id) => `#${id}`).join(',')}))`);
  return { solid: w.add(`MANIFOLD_SOLID_BREP('',#${shell})`) };
}

/** Surface colour (0..1 RGB) attached to a solid. */
function emitColour(w: Writer, solid: Solid, rgb: Vec, ctx: number): number {
  const colour = w.add(`COLOUR_RGB('',${r(rgb[0])},${r(rgb[1])},${r(rgb[2])})`);
  const fill = w.add(`FILL_AREA_STYLE_COLOUR('',#${colour})`);
  const style = w.add(`FILL_AREA_STYLE('',(#${fill}))`);
  const fillArea = w.add(`SURFACE_STYLE_FILL_AREA(#${style})`);
  const side = w.add(`SURFACE_SIDE_STYLE('',(#${fillArea}))`);
  const usage = w.add(`SURFACE_STYLE_USAGE(.BOTH.,#${side})`);
  const assignment = w.add(`PRESENTATION_STYLE_ASSIGNMENT((#${usage}))`);
  const styled = w.add(`STYLED_ITEM('',(#${assignment}),#${solid.solid})`);
  return w.add(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(#${styled}),#${ctx})`);
}

export type StepPartGeometry =
  | { kind: 'box'; size: Vec }
  | { kind: 'cylinder'; radius: number; height: number };

export interface StepPartSpec {
  name: string;
  geometry: StepPartGeometry;
  colour?: Vec;
}

export interface StepAssemblyComponent {
  part: StepPartSpec;
  /** Translation of the component inside the assembly, millimetres. */
  offset: Vec;
}

interface Header {
  w: Writer;
  ctx: number;
  appContext: number;
}

function emitHeader(w: Writer): Header {
  const appContext = w.add("APPLICATION_CONTEXT('core data for automotive mechanical design processes')");
  w.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appContext})`);
  // Complex entity: 3D context, mm / radian / steradian, 1e-5 accuracy.
  const mm = w.add('(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))');
  const rad = w.add('(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))');
  const sr = w.add('(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())');
  const tol = w.add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),#${mm},'DISTANCE_ACCURACY_VALUE','')`);
  const ctx = w.add(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${tol})) `
    + `GLOBAL_UNIT_ASSIGNED_CONTEXT((#${mm},#${rad},#${sr})) REPRESENTATION_CONTEXT('ctx','3D'))`,
  );
  return { w, ctx, appContext };
}

/** PRODUCT -> PRODUCT_DEFINITION -> PRODUCT_DEFINITION_SHAPE; returns the product definition id. */
function emitProduct(h: Header, name: string): { definition: number; shape: number } {
  const { w, appContext } = h;
  const productContext = w.add(`PRODUCT_CONTEXT('',#${appContext},'mechanical')`);
  const product = w.add(`PRODUCT('${name}','${name}','',(#${productContext}))`);
  w.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part','',(#${product}))`);
  const formation = w.add(`PRODUCT_DEFINITION_FORMATION('','',#${product})`);
  const definitionContext = w.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appContext},'design')`);
  const definition = w.add(`PRODUCT_DEFINITION('design','',#${formation},#${definitionContext})`);
  const shape = w.add(`PRODUCT_DEFINITION_SHAPE('','',#${definition})`);
  return { definition, shape };
}

/** A part: product + shape representation holding its solid. Returns what the assembly needs. */
function emitPart(h: Header, spec: StepPartSpec): { definition: number; shapeRep: number; placement: number } {
  const { w, ctx } = h;
  const product = emitProduct(h, spec.name);
  const solid = spec.geometry.kind === 'box'
    ? emitBox(w, spec.geometry.size)
    : emitCylinder(w, spec.geometry.radius, spec.geometry.height);
  const placement = axis(w, [0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const shapeRep = w.add(`SHAPE_REPRESENTATION('${spec.name}',(#${placement},#${solid.solid}),#${ctx})`);
  w.add(`SHAPE_DEFINITION_REPRESENTATION(#${product.shape},#${shapeRep})`);
  if (spec.colour) emitColour(w, solid, spec.colour, ctx);
  return { definition: product.definition, shapeRep, placement };
}

function finish(w: Writer, fileName: string): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('realvirtual WEB test fixture'),'2;1');",
    `FILE_NAME('${fileName}','2025-01-01T00:00:00',(''),(''),'','','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
    ...w.lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

/** A single part (no assembly structure), millimetres. */
export function singlePartStep(spec: StepPartSpec, fileName = 'part.stp'): string {
  const w = new Writer();
  const h = emitHeader(w);
  emitPart(h, spec);
  return finish(w, fileName);
}

/** An assembly of translated components under a named top-level product. */
export function assemblyStep(
  assemblyName: string,
  components: StepAssemblyComponent[],
  fileName = 'assembly.stp',
): string {
  const w = new Writer();
  const h = emitHeader(w);
  const top = emitProduct(h, assemblyName);
  const parts = components.map((c) => emitPart(h, c.part));

  const topOrigin = axis(w, [0, 0, 0], [0, 0, 1], [1, 0, 0]);
  const placements = components.map((c) => axis(w, c.offset, [0, 0, 1], [1, 0, 0]));
  const topRep = w.add(`SHAPE_REPRESENTATION('${assemblyName}',(#${topOrigin},${placements.map((p) => `#${p}`).join(',')}),#${h.ctx})`);
  w.add(`SHAPE_DEFINITION_REPRESENTATION(#${top.shape},#${topRep})`);

  components.forEach((c, i) => {
    const nauo = w.add(
      `NEXT_ASSEMBLY_USAGE_OCCURRENCE('${c.part.name}_${i + 1}','${c.part.name}','',#${top.definition},#${parts[i].definition},$)`,
    );
    const nauoShape = w.add(`PRODUCT_DEFINITION_SHAPE('','',#${nauo})`);
    const transform = w.add(`ITEM_DEFINED_TRANSFORMATION('','',#${parts[i].placement},#${placements[i]})`);
    const relation = w.add(
      `(REPRESENTATION_RELATIONSHIP('','',#${parts[i].shapeRep},#${topRep}) `
      + `REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#${transform}) SHAPE_REPRESENTATION_RELATIONSHIP())`,
    );
    w.add(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#${relation},#${nauoShape})`);
  });
  return finish(w, fileName);
}

export function stepBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
