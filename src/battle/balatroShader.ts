// ============================================================
// WebGL 实时域扭曲道韵漩涡着色器（暮色演武巨殿 · 火烧云色域统一版）
// 全部境界先统一套用傍晚火烧云演武场氛围，仅在周天运转/释放爆发/天劫降临时
// 增强赤霞翻涌与灵气辉光；不支持 WebGL 时静默降级，绝不阻塞游戏。
// ============================================================

interface Palette {
  c1: [number, number, number];
  c2: [number, number, number];
  c3: [number, number, number];
}

// 五大境界统一采用「傍晚火烧云演武场」暮色赤霄色域，随境界递进略微加深肃杀感
const REALM_PALETTES: Palette[] = [
  { c1: [0.24, 0.08, 0.05], c2: [0.76, 0.34, 0.11], c3: [0.06, 0.03, 0.04] },
  { c1: [0.25, 0.08, 0.05], c2: [0.78, 0.36, 0.12], c3: [0.06, 0.03, 0.04] },
  { c1: [0.27, 0.07, 0.05], c2: [0.82, 0.36, 0.11], c3: [0.07, 0.02, 0.03] },
  { c1: [0.26, 0.06, 0.07], c2: [0.80, 0.32, 0.12], c3: [0.06, 0.02, 0.04] },
  { c1: [0.28, 0.09, 0.04], c2: [0.86, 0.42, 0.13], c3: [0.06, 0.03, 0.03] },
];

const TRIB_PALETTES: Record<string, Palette> = {
  trib_demon: { c1: [0.30, 0.02, 0.04], c2: [0.74, 0.10, 0.12], c3: [0.05, 0.01, 0.02] },
  trib_thunder: { c1: [0.12, 0.06, 0.24], c2: [0.48, 0.28, 0.78], c3: [0.04, 0.02, 0.09] },
  trib_cloud: { c1: [0.24, 0.13, 0.04], c2: [0.88, 0.56, 0.16], c3: [0.06, 0.04, 0.02] },
};

const VERT_SRC = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG_SRC = `
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_res;
uniform float u_time;
uniform float u_spin;
uniform float u_energy;
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec3 u_c3;

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
  float len = length(uv);
  float angle = atan(uv.y, uv.x) + u_spin - 1.55 * exp(-len * 1.15) * (1.0 + u_energy * 0.55);
  vec2 p = vec2(cos(angle), sin(angle)) * len * 2.1;

  vec2 q = p;
  float t = u_time * 0.42;
  for (int i = 0; i < 4; i++) {
    q += sin(q.yx * 1.62 + vec2(t, -t * 0.85)) * 0.46;
    q = mat2(0.82, -0.57, 0.57, 0.82) * q;
  }

  float wave = 0.5 + 0.5 * sin(q.x * 2.5 - q.y * 2.0 + u_time * 0.65);
  float band = smoothstep(0.18, 0.86, wave);
  float ridge = pow(1.0 - abs(wave * 2.0 - 1.0), 3.0);

  vec3 col = mix(u_c3, u_c1, band);
  col = mix(col, u_c2, smoothstep(0.42, 0.96, wave) * (0.68 + u_energy * 0.34));
  col += u_c2 * ridge * (0.28 + u_energy * 0.48);

  float horizonGlow = exp(-pow(uv.y - 0.12, 2.0) * 5.0) * (0.18 + u_energy * 0.18);
  col += u_c2 * horizonGlow;
  float vig = smoothstep(1.28, 0.25, len);
  col *= (0.48 + 0.52 * vig);

  gl_FragColor = vec4(col, 1.0);
}
`;

const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

export class BalatroBackdrop {
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private cur: Palette = { c1: [...REALM_PALETTES[0].c1], c2: [...REALM_PALETTES[0].c2], c3: [...REALM_PALETTES[0].c3] };
  private target: Palette = REALM_PALETTES[0];
  private time = 0;
  private spin = 0;
  private energy = 0;
  private targetEnergy = 0;
  private lastNow = 0;
  private rafId = 0;
  private readonly reducedMotion: boolean;

  constructor(private readonly canvas: HTMLCanvasElement | null) {
    this.reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (!canvas) return;
    try {
      const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false });
      if (!gl) return;
      const vs = this.compile(gl, gl.VERTEX_SHADER, VERT_SRC);
      const fs = this.compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
      if (!vs || !fs) return;
      const prog = gl.createProgram();
      if (!prog) return;
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'a_pos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      this.gl = gl;
      this.program = prog;
      this.uniforms = {
        res: gl.getUniformLocation(prog, 'u_res'),
        time: gl.getUniformLocation(prog, 'u_time'),
        spin: gl.getUniformLocation(prog, 'u_spin'),
        energy: gl.getUniformLocation(prog, 'u_energy'),
        c1: gl.getUniformLocation(prog, 'u_c1'),
        c2: gl.getUniformLocation(prog, 'u_c2'),
        c3: gl.getUniformLocation(prog, 'u_c3'),
      };
    } catch {
      this.gl = null;
    }
  }

  private compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return null;
    return sh;
  }

  setTheme(realm: number, tribulationId: string | null = null): void {
    if (tribulationId && TRIB_PALETTES[tribulationId]) {
      this.target = TRIB_PALETTES[tribulationId];
      return;
    }
    const idx = Math.max(0, Math.min(REALM_PALETTES.length - 1, realm - 1));
    this.target = REALM_PALETTES[idx];
  }

  setEnergy(level: number): void {
    this.targetEnergy = Math.max(0, Math.min(1.5, level));
  }

  pulse(boost = 0.55): void {
    this.energy = Math.min(1.6, this.energy + boost);
  }

  start(): void {
    if (!this.gl || !this.program || !this.canvas) return;
    const tick = (now: number): void => {
      const dt = Math.min(0.05, Math.max(0, (now - this.lastNow) / 1000 || 0.016));
      this.lastNow = now;
      const speed = this.reducedMotion ? 0.12 : 1.0;
      this.energy = lerp(this.energy, this.targetEnergy, Math.min(1, dt * 3.5));
      this.time += dt * speed * (0.6 + this.energy * 0.9);
      this.spin += dt * speed * (0.12 + this.energy * 0.42);

      const mixK = Math.min(1, dt * 2.2);
      for (let i = 0; i < 3; i++) {
        this.cur.c1[i] = lerp(this.cur.c1[i], this.target.c1[i], mixK);
        this.cur.c2[i] = lerp(this.cur.c2[i], this.target.c2[i], mixK);
        this.cur.c3[i] = lerp(this.cur.c3[i], this.target.c3[i], mixK);
      }

      const gl = this.gl!;
      gl.viewport(0, 0, this.canvas!.width, this.canvas!.height);
      gl.useProgram(this.program);
      gl.uniform2f(this.uniforms.res, this.canvas!.width, this.canvas!.height);
      gl.uniform1f(this.uniforms.time, this.time);
      gl.uniform1f(this.uniforms.spin, this.spin);
      gl.uniform1f(this.uniforms.energy, this.energy);
      gl.uniform3fv(this.uniforms.c1, this.cur.c1);
      gl.uniform3fv(this.uniforms.c2, this.cur.c2);
      gl.uniform3fv(this.uniforms.c3, this.cur.c3);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      this.rafId = requestAnimationFrame(tick);
    };
    this.lastNow = performance.now();
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }
}
