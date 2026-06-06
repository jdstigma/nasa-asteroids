"use strict";

import powerbi from "powerbi-visuals-api";
import * as THREE from "three";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import { VisualSettings } from "./settings";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions      = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual                  = powerbi.extensibility.visual.IVisual;
import DataView                 = powerbi.DataView;

const DEG     = Math.PI / 180;
const MAX_AU  = 32;
const R_MIN_AU = 0.3;
const SCENE_R = 100;       // scene units the outermost orbit maps to
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

// ---------------------------------------------------------------------------
// Planet elements (J2000): a (AU), e, inclination i (deg), node Ω (deg),
// argument of perihelion ω (deg), period (days), display color + radius.
// ---------------------------------------------------------------------------
interface PlanetDef {
    name: string; color: number; radius: number;
    a: number; e: number; i: number; node: number; peri: number; period: number;
    tilt: number;   // axial tilt (deg) — orients texture & ring; also the self-spin axis
}
const PLANETS: PlanetDef[] = [
    { name: "Mercury", color: 0xd8d8e0, radius: 1.6, a: 0.387, e: 0.206, i: 7.00, node: 48.3,  peri: 29.1,  period: 87.97,    tilt: 0.03 },
    { name: "Venus",   color: 0xffd24d, radius: 2.4, a: 0.723, e: 0.007, i: 3.39, node: 76.7,  peri: 54.9,  period: 224.70,   tilt: 2.6  },
    { name: "Earth",   color: 0x2ea6ff, radius: 2.6, a: 1.000, e: 0.017, i: 0.00, node: 0.0,   peri: 102.9, period: 365.25,   tilt: 23.4 },
    { name: "Mars",    color: 0xff4d2e, radius: 2.2, a: 1.524, e: 0.093, i: 1.85, node: 49.6,  peri: 336.0, period: 686.97,   tilt: 25.2 },
    { name: "Jupiter", color: 0xff9a3c, radius: 5.0, a: 5.203, e: 0.049, i: 1.30, node: 100.5, peri: 14.3,  period: 4332.59,  tilt: 3.1  },
    { name: "Saturn",  color: 0xf5e05a, radius: 4.4, a: 9.537, e: 0.057, i: 2.49, node: 113.7, peri: 92.4,  period: 10759.22, tilt: 26.7 },
    { name: "Uranus",  color: 0x3df0e0, radius: 3.4, a: 19.19, e: 0.046, i: 0.77, node: 74.0,  peri: 170.9, period: 30685.40, tilt: 97.8 },
    { name: "Neptune", color: 0x6a7bff, radius: 3.4, a: 30.07, e: 0.010, i: 1.77, node: 131.8, peri: 44.9,  period: 60190.03, tilt: 28.3 },
];

const COL = {
    name: "name", shortName: "short_name", hazardous: "potentially_hazardous",
    diameterMax: "diameter_max_m", semiMajorAxis: "semi_major_axis", eccentricity: "eccentricity",
    inclination: "inclination", ascNode: "ascending_node_longitude", periArgument: "perihelion_argument",
    missDistAU: "miss_distance_au", approachDate: "close_approach_date", velocityKmS: "velocity_km_s",
    orbitingBody: "orbiting_body", magnitude: "magnitude", orbitClass: "orbit_class_type",
    firstObs: "first_observation_date", lastObs: "last_observation_date",
};

interface ApproachEvent { dayJ2000: number; orbitingBody: string; }
interface Asteroid {
    name: string; hazardous: boolean; diameterM: number;
    a: number; e: number; i: number; node: number; peri: number;
    firstSeenDay: number; lastSeenDay: number;
    approaches: ApproachEvent[];
}

// ---------------------------------------------------------------------------
// Maths
// ---------------------------------------------------------------------------
function meanToTrue(M: number, e: number): number {
    let E = M;
    for (let k = 0; k < 8; k++) E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
}

// Logarithmic radial scaling AU -> scene units (keeps inner planets readable)
function auToScene(rAU: number): number {
    const r = Math.max(R_MIN_AU, Math.min(rAU, MAX_AU));
    return (Math.log(r) - Math.log(R_MIN_AU)) / (Math.log(MAX_AU) - Math.log(R_MIN_AU)) * SCENE_R;
}

// 3D heliocentric position (ecliptic) for orbital elements at true anomaly nu (rad)
function keplerVec(a: number, e: number, iDeg: number, nodeDeg: number, periDeg: number, nu: number): THREE.Vector3 {
    const r = (a * (1 - e * e)) / (1 + e * Math.cos(nu));
    const xp = r * Math.cos(nu), yp = r * Math.sin(nu);
    const i = iDeg * DEG, O = nodeDeg * DEG, w = periDeg * DEG;
    const cosO = Math.cos(O), sinO = Math.sin(O), cosi = Math.cos(i), sini = Math.sin(i), cosw = Math.cos(w), sinw = Math.sin(w);
    // rotate orbital plane -> ecliptic
    const x = (cosO * cosw - sinO * sinw * cosi) * xp + (-cosO * sinw - sinO * cosw * cosi) * yp;
    const y = (sinO * cosw + cosO * sinw * cosi) * xp + (-sinO * sinw + cosO * cosw * cosi) * yp;
    const z = (sinw * sini) * xp + (cosw * sini) * yp;
    // log-scale the magnitude, keep direction; map ecliptic (x,y) plane to scene (x,z), z->y up
    const rAU = Math.sqrt(x * x + y * y + z * z) || 1e-6;
    const s = auToScene(rAU) / rAU;
    return new THREE.Vector3(x * s, z * s, y * s);
}

// ---------------------------------------------------------------------------
export class Visual implements IVisual {
    private host: powerbi.extensibility.visual.IVisualHost;
    private formattingSettingsService: FormattingSettingsService;
    private formattingSettings: VisualSettings;

    private container: HTMLDivElement;
    private renderer: THREE.WebGLRenderer;
    private scene: THREE.Scene;
    private camera: THREE.PerspectiveCamera;

    private planetMeshes: THREE.Mesh[] = [];
    private planetOrbits: THREE.LineLoop[] = [];
    private asteroidPoints: THREE.Points;
    private asteroidGeom: THREE.BufferGeometry;
    private orbitPool: Map<string, THREE.Line> = new Map();
    private labelPool: Map<string, HTMLDivElement> = new Map();

    private width = 800; private height = 600;
    private asteroids: Asteroid[] = [];

    // camera orbit state (spherical)
    private camRadius = 220; private camTheta = 0.6; private camPhi = 1.1;
    private dragging = false; private lastX = 0; private lastY = 0;

    // playback
    private daysSinceJ2000 = 0;
    private simMinDays = (Date.UTC(1930, 0, 1)  - J2000_MS) / 86400000;
    private simMaxDays = (Date.UTC(2026, 11, 31) - J2000_MS) / 86400000;
    private animSpeed = 1; private paused = false; private playDir = 1; private isScrubbing = false;
    private showAllPlanets = true; private showHazardousOnly = false; private lineThreshold = 0.55;

    private playBtn: HTMLButtonElement; private scrubber: HTMLInputElement; private dateLabel: HTMLSpanElement;
    private rafId: number | null = null;

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.formattingSettingsService = new FormattingSettingsService();
        this.formattingSettings = new VisualSettings();
        this.daysSinceJ2000 = this.simMinDays;

        this.container = document.createElement("div");
        this.container.className = "orbital3d-container";
        options.element.appendChild(this.container);

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        this.renderer.setPixelRatio(window.devicePixelRatio || 1);
        this.renderer.setClearColor(0x03030a, 1);
        this.container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 5000);

        this.buildScene();
        this.attachCameraControls();
        this.buildControls();
        this.animate();
    }

    // Soft radial-gradient sprite texture used for glows and round dots
    private glowTexture: THREE.Texture;
    private makeGlowTexture(): THREE.Texture {
        const c = document.createElement("canvas");
        c.width = c.height = 64;
        const ctx = c.getContext("2d")!;
        const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        g.addColorStop(0,   "rgba(255,255,255,1)");
        g.addColorStop(0.4, "rgba(255,255,255,0.55)");
        g.addColorStop(1,   "rgba(255,255,255,0)");
        ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
        const tex = new THREE.Texture(c); tex.needsUpdate = true;
        return tex;
    }

    private addGlowSprite(parent: THREE.Object3D, color: number, scale: number): void {
        const mat = new THREE.SpriteMaterial({
            map: this.glowTexture, color, blending: THREE.AdditiveBlending,
            transparent: true, depthWrite: false,
        });
        const sprite = new THREE.Sprite(mat);
        sprite.scale.setScalar(scale);
        parent.add(sprite);
    }

    // -----------------------------------------------------------------------
    // Procedural planet surface textures, drawn to an equirectangular canvas.
    // No external assets — each planet is recognisable from its real colouring
    // and surface character (bands, craters, ice caps, the Great Red Spot…).
    // -----------------------------------------------------------------------
    private makePlanetTexture(name: string): THREE.CanvasTexture {
        const W = 512, H = 256;
        const c = document.createElement("canvas");
        c.width = W; c.height = H;
        const ctx = c.getContext("2d")!;

        const fill = (col: string) => { ctx.fillStyle = col; ctx.fillRect(0, 0, W, H); };
        // Random soft blob (albedo feature / landmass)
        const blob = (col: string, alpha: number, count: number, rMin: number, rMax: number) => {
            ctx.fillStyle = col;
            for (let i = 0; i < count; i++) {
                ctx.globalAlpha = alpha * (0.5 + Math.random() * 0.5);
                const x = Math.random() * W, y = Math.random() * H;
                const rx = rMin + Math.random() * (rMax - rMin);
                const ry = rx * (0.5 + Math.random() * 0.7);
                ctx.beginPath();
                ctx.ellipse(x, y, rx, ry, Math.random() * Math.PI, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
        };
        // Horizontal turbulent bands for gas giants
        const bands = (palette: string[], rows: number, wob: number) => {
            const bh = H / rows;
            for (let r = 0; r < rows; r++) {
                ctx.fillStyle = palette[r % palette.length];
                for (let x = 0; x < W; x += 4) {
                    const dy = Math.sin((x / W) * Math.PI * 6 + r) * wob
                             + (Math.random() - 0.5) * wob * 0.6;
                    ctx.fillRect(x, r * bh + dy, 5, bh + Math.abs(dy) + 1);
                }
            }
        };
        // White polar ice caps top & bottom
        const iceCaps = (frac: number) => {
            for (const top of [true, false]) {
                const g = ctx.createLinearGradient(0, top ? 0 : H, 0, top ? H * frac : H - H * frac);
                g.addColorStop(0, "rgba(255,255,255,0.95)");
                g.addColorStop(1, "rgba(255,255,255,0)");
                ctx.fillStyle = g;
                ctx.fillRect(0, top ? 0 : H - H * frac, W, H * frac);
            }
        };
        // Fine speckle noise over the whole disc
        const speckle = (col: string, alpha: number, n: number) => {
            ctx.fillStyle = col; ctx.globalAlpha = alpha;
            for (let i = 0; i < n; i++) ctx.fillRect(Math.random() * W, Math.random() * H, 1.5, 1.5);
            ctx.globalAlpha = 1;
        };

        switch (name) {
            case "Mercury": {
                fill("#8a8783");
                blob("#6f6c68", 0.4, 60, 6, 26);     // darker plains
                blob("#a09c97", 0.3, 50, 4, 18);     // brighter ejecta
                // craters: dark floor + light rim
                for (let i = 0; i < 140; i++) {
                    const x = Math.random() * W, y = Math.random() * H, r = 1.5 + Math.random() * 7;
                    ctx.strokeStyle = "rgba(190,188,184,0.5)"; ctx.lineWidth = 1;
                    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
                    ctx.fillStyle = "rgba(70,68,64,0.45)";
                    ctx.beginPath(); ctx.arc(x, y, r * 0.7, 0, Math.PI * 2); ctx.fill();
                }
                speckle("#5d5b57", 0.25, 1200);
                break;
            }
            case "Venus": {
                fill("#d9c08a");
                blob("#e8d8a8", 0.4, 40, 30, 90);    // bright cloud swirls
                blob("#c2a062", 0.35, 40, 30, 90);   // darker cloud lanes
                speckle("#efe2bc", 0.15, 800);
                break;
            }
            case "Earth": {
                fill("#13407a");                      // deep ocean
                blob("#1d5aa0", 0.5, 30, 30, 80);    // shallower seas
                // continents
                blob("#3f7d3a", 0.85, 26, 18, 60);   // green
                blob("#6f7d3f", 0.6, 26, 14, 48);    // scrub
                blob("#7a6a48", 0.5, 20, 10, 36);    // arid
                iceCaps(0.13);
                blob("rgba(255,255,255,1)", 0.25, 40, 16, 50);  // clouds
                break;
            }
            case "Mars": {
                fill("#b5532a");
                blob("#8f3f1f", 0.5, 40, 20, 70);    // dark albedo regions
                blob("#cf7a4a", 0.4, 40, 16, 55);    // lighter dust
                blob("#5e2e18", 0.35, 18, 8, 26);    // canyons/shadows
                iceCaps(0.09);
                speckle("#7a3a1f", 0.2, 900);
                break;
            }
            case "Jupiter": {
                bands(["#caa472", "#9c6b42", "#d8c4a0", "#b58a5e", "#8a5a36", "#c9b48c"], 13, 5);
                // Great Red Spot
                ctx.fillStyle = "#b5462e"; ctx.globalAlpha = 0.85;
                ctx.beginPath(); ctx.ellipse(W * 0.66, H * 0.62, 34, 18, 0, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = "#d06a4e"; ctx.globalAlpha = 0.6;
                ctx.beginPath(); ctx.ellipse(W * 0.66, H * 0.62, 22, 11, 0, 0, Math.PI * 2); ctx.fill();
                ctx.globalAlpha = 1;
                break;
            }
            case "Saturn": {
                bands(["#e6d3a8", "#d2bb8a", "#ead9b4", "#c9b07e", "#ddc899"], 11, 3);
                break;
            }
            case "Uranus": {
                fill("#a8e6e0");
                bands(["#a8e6e0", "#9fdcd6", "#b0ebe6"], 7, 1.5);
                break;
            }
            case "Neptune": {
                fill("#2e4ea8");
                bands(["#2e4ea8", "#3a5ec0", "#28448f"], 8, 2);
                ctx.fillStyle = "#1c2f6e"; ctx.globalAlpha = 0.75;   // Great Dark Spot
                ctx.beginPath(); ctx.ellipse(W * 0.4, H * 0.42, 26, 15, 0, 0, Math.PI * 2); ctx.fill();
                ctx.globalAlpha = 1;
                break;
            }
            default:
                fill("#888888");
        }

        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = THREE.RepeatWrapping;       // seamless horizontal wrap for bands
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        return tex;
    }

    // Radial ring-system texture (gold bands with the Cassini division gap).
    private makeRingTexture(): THREE.CanvasTexture {
        const W = 256, H = 8;
        const c = document.createElement("canvas");
        c.width = W; c.height = H;
        const ctx = c.getContext("2d")!;
        for (let x = 0; x < W; x++) {
            const t = x / (W - 1);                         // 0 = inner edge, 1 = outer
            let a = 0.85;
            if (t < 0.04 || t > 0.97) a = 0;               // soft inner/outer fade
            else if (t > 0.62 && t < 0.69) a = 0.12;       // Cassini division
            else if (t > 0.46 && t < 0.50) a = 0.35;       // a fainter gap
            const shade = 200 + Math.floor(Math.sin(t * 40) * 18 + Math.random() * 12);
            ctx.fillStyle = `rgba(${shade},${shade - 25},${shade - 70},${a})`;
            ctx.fillRect(x, 0, 1, H);
        }
        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        return tex;
    }

    // Saturn's ring disc: a flat annulus in the planet's local equatorial plane,
    // UV-remapped so the ring texture runs radially (inner→outer).
    private addSaturnRing(parent: THREE.Object3D, planetRadius: number): void {
        const inner = planetRadius * 1.35, outer = planetRadius * 2.35;
        const geo = new THREE.RingGeometry(inner, outer, 96, 1);
        const pos = geo.attributes.position as THREE.BufferAttribute;
        const uv  = geo.attributes.uv as THREE.BufferAttribute;
        const v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i);
            const r = (v.length() - inner) / (outer - inner);   // 0..1 radial
            uv.setXY(i, r, 0.5);
        }
        uv.needsUpdate = true;
        const mat = new THREE.MeshBasicMaterial({
            map: this.makeRingTexture(), side: THREE.DoubleSide,
            transparent: true, depthWrite: false, opacity: 0.95,
        });
        const ring = new THREE.Mesh(geo, mat);
        ring.rotation.x = Math.PI / 2;        // lie in parent's local XZ (equatorial) plane
        ring.renderOrder = 1;
        parent.add(ring);                     // child → inherits axial tilt, stable under Y-spin
    }

    // -----------------------------------------------------------------------
    private buildScene(): void {
        this.glowTexture = this.makeGlowTexture();

        // Sun + glow
        const sun = new THREE.Mesh(
            new THREE.SphereGeometry(5, 32, 32),
            new THREE.MeshBasicMaterial({ color: 0xffe066 })
        );
        this.scene.add(sun);
        this.addGlowSprite(sun, 0xffdd66, 30);   // inner glow
        this.addGlowSprite(sun, 0xffaa33, 70);   // outer corona
        const sunLight = new THREE.PointLight(0xffffff, 2.6, 0, 0.0);
        this.scene.add(sunLight);
        this.scene.add(new THREE.AmbientLight(0x6677aa, 0.45));

        // Starfield
        const starGeo = new THREE.BufferGeometry();
        const starN = 1500; const sp = new Float32Array(starN * 3);
        for (let i = 0; i < starN; i++) {
            const v = new THREE.Vector3().randomDirection().multiplyScalar(900 + Math.random() * 600);
            sp[i*3] = v.x; sp[i*3+1] = v.y; sp[i*3+2] = v.z;
        }
        starGeo.setAttribute("position", new THREE.BufferAttribute(sp, 3));
        this.scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.2, sizeAttenuation: false })));

        // Planets + orbit rings
        const planets = this.showAllPlanets ? PLANETS : PLANETS.slice(0, 4);
        for (const p of planets) this.addPlanet(p);

        // Asteroid points — custom shader so each point can be sized by diameter
        this.asteroidGeom = new THREE.BufferGeometry();
        this.asteroidGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
        this.asteroidGeom.setAttribute("acolor",   new THREE.BufferAttribute(new Float32Array(3), 3));
        this.asteroidGeom.setAttribute("size",     new THREE.BufferAttribute(new Float32Array(1), 1));
        const aMat = new THREE.ShaderMaterial({
            uniforms: { map: { value: this.glowTexture } },
            vertexShader: `
                attribute float size;
                attribute vec3 acolor;
                varying vec3 vColor;
                void main() {
                    vColor = acolor;
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    gl_PointSize = size * (240.0 / -mv.z);
                    gl_Position = projectionMatrix * mv;
                }`,
            fragmentShader: `
                uniform sampler2D map;
                varying vec3 vColor;
                void main() {
                    vec4 t = texture2D(map, gl_PointCoord);
                    if (t.a < 0.05) discard;
                    gl_FragColor = vec4(vColor, t.a);
                }`,
            transparent: true, depthWrite: false, blending: THREE.NormalBlending,
        });
        this.asteroidPoints = new THREE.Points(this.asteroidGeom, aMat);
        this.scene.add(this.asteroidPoints);
    }

    private addPlanet(p: PlanetDef): void {
        const tex = this.makePlanetTexture(p.name);
        const mesh = new THREE.Mesh(
            new THREE.SphereGeometry(p.radius, 48, 48),
            new THREE.MeshStandardMaterial({
                map: tex,
                emissiveMap: tex,                // faint self-glow so the night side isn't black
                emissive: 0xffffff, emissiveIntensity: 0.12,
                roughness: 0.9, metalness: 0.0,
            })
        );
        mesh.rotation.x = p.tilt * DEG;          // axial tilt; also the self-spin axis
        (mesh as any).userData = p;
        // Subtler atmospheric halo (textured surface now carries the look)
        this.addGlowSprite(mesh, p.color, p.radius * 3.2);
        if (p.name === "Saturn") this.addSaturnRing(mesh, p.radius);
        this.scene.add(mesh);
        this.planetMeshes.push(mesh);

        // Orbit ring
        const pts: THREE.Vector3[] = [];
        for (let k = 0; k <= 220; k++) {
            const nu = (k / 220) * 2 * Math.PI;
            pts.push(keplerVec(p.a, p.e, p.i, p.node, p.peri, nu));
        }
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const ring = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: p.color, transparent: true, opacity: 0.4 }));
        this.scene.add(ring);
        this.planetOrbits.push(ring);
    }

    // -----------------------------------------------------------------------
    private attachCameraControls(): void {
        const el = this.renderer.domElement;
        el.style.cursor = "grab";
        el.addEventListener("mousedown", (e) => { this.dragging = true; this.lastX = e.clientX; this.lastY = e.clientY; el.style.cursor = "grabbing"; });
        window.addEventListener("mouseup", () => { this.dragging = false; el.style.cursor = "grab"; });
        window.addEventListener("mousemove", (e) => {
            if (!this.dragging) return;
            this.camTheta -= (e.clientX - this.lastX) * 0.005;
            this.camPhi   -= (e.clientY - this.lastY) * 0.005;
            this.camPhi = Math.max(0.05, Math.min(Math.PI - 0.05, this.camPhi));
            this.lastX = e.clientX; this.lastY = e.clientY;
        });
        el.addEventListener("wheel", (e) => {
            e.preventDefault();
            this.camRadius *= (1 + Math.sign(e.deltaY) * 0.08);
            this.camRadius = Math.max(20, Math.min(1200, this.camRadius));
        }, { passive: false });
        el.addEventListener("dblclick", () => { this.camRadius = 220; this.camTheta = 0.6; this.camPhi = 1.1; });
    }

    private updateCamera(): void {
        const x = this.camRadius * Math.sin(this.camPhi) * Math.cos(this.camTheta);
        const y = this.camRadius * Math.cos(this.camPhi);
        const z = this.camRadius * Math.sin(this.camPhi) * Math.sin(this.camTheta);
        this.camera.position.set(x, y, z);
        this.camera.lookAt(0, 0, 0);
    }

    // -----------------------------------------------------------------------
    public update(options: VisualUpdateOptions): void {
        this.width = options.viewport.width;
        this.height = options.viewport.height;
        this.renderer.setSize(this.width, this.height);   // updates canvas CSS size too (keeps it centered)
        this.camera.aspect = this.width / Math.max(1, this.height);
        this.camera.updateProjectionMatrix();

        if (options.dataViews && options.dataViews[0]) {
            this.formattingSettings = this.formattingSettingsService.populateFormattingSettingsModel(VisualSettings, options.dataViews[0]);
            const d = this.formattingSettings.display;
            this.showAllPlanets    = d.showAllPlanets.value;
            this.showHazardousOnly = d.showHazardousOnly.value;
            this.animSpeed         = d.animationSpeed.value;
            this.lineThreshold     = d.lineThreshold.value;
            this.parseData(options.dataViews[0]);
        }
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.formattingSettingsService.buildFormattingModel(this.formattingSettings);
    }

    // -----------------------------------------------------------------------
    private parseData(dataView: DataView): void {
        this.asteroids = [];
        if (!dataView.table) return;
        const cols = dataView.table.columns, rows = dataView.table.rows;

        const normalize = (raw: string): string =>
            (raw || "").toLowerCase()
                .replace(/^(sum|count|countnonnull|average|avg|min|max|median|first|last|var|stdev) of /, "")
                .split(".").pop()!.replace(/[^a-z0-9_]/g, "");
        const idx: Record<string, number> = {};
        cols.forEach((c, i) => {
            const kd = normalize(c.displayName), kq = normalize(c.queryName);
            if (kd && !(kd in idx)) idx[kd] = i;
            if (kq && !(kq in idx)) idx[kq] = i;
        });
        const gS = (row: powerbi.DataViewTableRow, n: string) => String(row[idx[n]] ?? "").trim();
        const gN = (row: powerbi.DataViewTableRow, n: string) => parseFloat(gS(row, n)) || 0;
        const dayOf = (s: string) => { const ms = Date.parse(s); return isNaN(ms) ? NaN : (ms - J2000_MS) / 86400000; };

        const map = new Map<string, Asteroid>();
        for (const row of rows) {
            const name = gS(row, COL.name);
            if (!name) continue;
            if (!map.has(name)) {
                map.set(name, {
                    name,
                    hazardous: gS(row, COL.hazardous).toLowerCase() === "true",
                    diameterM: gN(row, COL.diameterMax),
                    a: gN(row, COL.semiMajorAxis), e: gN(row, COL.eccentricity),
                    i: gN(row, COL.inclination), node: gN(row, COL.ascNode), peri: gN(row, COL.periArgument),
                    firstSeenDay: dayOf(gS(row, COL.firstObs)), lastSeenDay: dayOf(gS(row, COL.lastObs)),
                    approaches: [],
                });
            }
            const d = dayOf(gS(row, COL.approachDate));
            if (!isNaN(d)) map.get(name)!.approaches.push({ dayJ2000: d, orbitingBody: gS(row, COL.orbitingBody) });
        }
        this.asteroids = Array.from(map.values()).filter(a => a.a > 0 && a.e < 1 && a.a <= MAX_AU);

        // resize asteroid buffers
        const n = Math.max(1, this.asteroids.length);
        this.asteroidGeom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        this.asteroidGeom.setAttribute("acolor",   new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        this.asteroidGeom.setAttribute("size",     new THREE.BufferAttribute(new Float32Array(n), 1));
    }

    // -----------------------------------------------------------------------
    private inObsWindow(a: Asteroid): boolean {
        const now = this.daysSinceJ2000;
        return (isNaN(a.firstSeenDay) || now >= a.firstSeenDay) && (isNaN(a.lastSeenDay) || now <= a.lastSeenDay);
    }

    // fade 0..1 over the observation lifecycle (ramp to approach, wind down to last obs),
    // plus the orbiting body of the driving approach and the |days| to that approach.
    private fadeInfo(a: Asteroid): { fade: number; body: string; daysToApproach: number } {
        const now = this.daysSinceJ2000;
        let best = 0, body = "", dta = Infinity;
        for (const ap of a.approaches) {
            const approach = ap.dayJ2000;
            const start = (!isNaN(a.firstSeenDay) && a.firstSeenDay < approach) ? a.firstSeenDay : approach - 730;
            const end   = (!isNaN(a.lastSeenDay)  && a.lastSeenDay  > approach) ? a.lastSeenDay  : approach + 730;
            let f = 0;
            if (now >= start && now <= approach)      f = (approach - start) > 0 ? 0.15 + 0.85 * ((now - start) / (approach - start)) : 1;
            else if (now > approach && now <= end)    f = (end - approach) > 0 ? 1 - (now - approach) / (end - approach) : 0;
            if (f > best) { best = f; body = ap.orbitingBody; dta = Math.abs(now - approach); }
        }
        return { fade: best, body, daysToApproach: dta };
    }

    private asteroidVec(a: Asteroid): THREE.Vector3 {
        const period = 365.25 * Math.pow(a.a, 1.5);
        const M = (2 * Math.PI * this.daysSinceJ2000) / period;
        const Mn = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        return keplerVec(a.a, a.e, a.i, a.node, a.peri, meanToTrue(Mn, a.e));
    }

    // -----------------------------------------------------------------------
    private updateBodies(): void {
        // Planets
        for (const mesh of this.planetMeshes) {
            const p = (mesh as any).userData as PlanetDef;
            const M = (2 * Math.PI * this.daysSinceJ2000) / p.period;
            const Mn = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
            const v = keplerVec(p.a, p.e, p.i, p.node, p.peri, meanToTrue(Mn, p.e));
            mesh.position.copy(v);
            // Gentle self-spin about the tilted local-Y axis so the texture reads as
            // a rotating globe. Gas giants spin faster; Saturn's ring (in the local
            // equatorial plane) is invariant under this rotation, so it stays put.
            mesh.rotation.y += p.radius >= 4 ? 0.006 : 0.0025;
        }

        // Asteroid points (only within observation window)
        const pos  = this.asteroidGeom.getAttribute("position") as THREE.BufferAttribute;
        const col  = this.asteroidGeom.getAttribute("acolor") as THREE.BufferAttribute;
        const size = this.asteroidGeom.getAttribute("size") as THREE.BufferAttribute;
        const list = this.showHazardousOnly ? this.asteroids.filter(a => a.hazardous) : this.asteroids;
        // Fast blink toggle (~6 Hz) for asteroids sitting at their close-approach point
        const blinkOn = Math.floor(performance.now() / 80) % 2 === 0;
        let n = 0;
        const activeForLines: { a: Asteroid; fade: number }[] = [];
        for (const a of list) {
            if (!this.inObsWindow(a)) continue;
            const info = this.fadeInfo(a);
            const fade = info.fade;
            const v = this.asteroidVec(a);
            pos.setXYZ(n, v.x, v.y, v.z);

            // At the close-approach point (within ~10 days) the asteroid blinks on/off fast
            const atApproach = info.daysToApproach <= 10;
            let b = 0.4 + 0.6 * fade;
            if (atApproach && !blinkOn) b = 0;          // blink "off" frame
            else if (atApproach)        b = 1.3;        // blink "on" frame (extra bright)
            if (a.hazardous) col.setXYZ(n, Math.min(1, 1.0 * (b || 0)), 0.35 * b, 0.3 * b);
            else             col.setXYZ(n, 0.8 * b, 0.82 * b, 0.9 * b);

            const base = a.hazardous ? 6 : 4;
            const dscale = a.diameterM ? Math.min(10, base + Math.log10(a.diameterM + 1) * 2.2) : base;
            size.setX(n, dscale * (0.6 + 0.4 * fade) * (atApproach ? 1.4 : 1));
            n++;

            if (fade >= this.lineThreshold) activeForLines.push({ a, fade });
        }
        this.asteroidGeom.setDrawRange(0, n);
        pos.needsUpdate = true; col.needsUpdate = true; size.needsUpdate = true;

        this.updateOrbitLines(activeForLines);
        this.updatePlanetLabels();
    }

    private updateOrbitLines(active: { a: Asteroid; fade: number }[]): void {
        const seen = new Set<string>();
        for (const { a, fade } of active) {
            seen.add(a.name);
            let line = this.orbitPool.get(a.name);
            if (!line) {
                const pts: THREE.Vector3[] = [];
                for (let k = 0; k <= 160; k++) pts.push(keplerVec(a.a, a.e, a.i, a.node, a.peri, (k / 160) * 2 * Math.PI));
                const geo = new THREE.BufferGeometry().setFromPoints(pts);
                const mat = new THREE.LineBasicMaterial({ color: a.hazardous ? 0xff4444 : 0x9aa6bf, transparent: true, opacity: 0.5 });
                line = new THREE.Line(geo, mat);
                this.scene.add(line);
                this.orbitPool.set(a.name, line);
            }
            (line.material as THREE.LineBasicMaterial).opacity = (a.hazardous ? 0.85 : 0.5) * fade;
        }
        // remove orbits no longer active
        for (const [name, line] of this.orbitPool) {
            if (!seen.has(name)) {
                this.scene.remove(line);
                line.geometry.dispose();
                (line.material as THREE.Material).dispose();
                this.orbitPool.delete(name);
            }
        }
    }

    // Planet name labels, projected from each planet's 3D position to screen space
    private updatePlanetLabels(): void {
        const tmp = new THREE.Vector3();
        for (const mesh of this.planetMeshes) {
            const p = (mesh as any).userData as PlanetDef;
            let el = this.labelPool.get(p.name);
            if (!el) {
                el = document.createElement("div");
                Object.assign(el.style, {
                    position: "absolute", pointerEvents: "none", fontFamily: "sans-serif",
                    fontSize: "11px", fontWeight: "600", color: "#ffffff",
                    textShadow: "0 0 3px #000, 0 0 3px #000",
                    transform: "translate(-50%, -160%)", whiteSpace: "nowrap",
                } as CSSStyleDeclaration);
                el.textContent = p.name;
                el.style.color = "#" + p.color.toString(16).padStart(6, "0");
                this.container.appendChild(el);
                this.labelPool.set(p.name, el);
            }
            tmp.copy(mesh.position).project(this.camera);
            if (tmp.z > 1) { el.style.display = "none"; continue; }
            el.style.display = "block";
            el.style.left = ((tmp.x * 0.5 + 0.5) * this.width) + "px";
            el.style.top  = ((-tmp.y * 0.5 + 0.5) * this.height) + "px";
        }
    }

    // -----------------------------------------------------------------------
    private animate = (): void => {
        if (!this.paused && !this.isScrubbing) {
            this.daysSinceJ2000 += this.animSpeed * this.playDir;
            if (this.daysSinceJ2000 > this.simMaxDays) this.daysSinceJ2000 = this.simMinDays;
            if (this.daysSinceJ2000 < this.simMinDays) this.daysSinceJ2000 = this.simMaxDays;
        }
        this.updateBodies();
        this.updateCamera();
        this.refreshScrubber();
        this.renderer.render(this.scene, this.camera);
        this.rafId = requestAnimationFrame(this.animate);
    };

    // -----------------------------------------------------------------------
    private dayToDate(day: number): string {
        const d = new Date(J2000_MS + day * 86400000);
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    }

    private buildControls(): void {
        const bar = document.createElement("div");
        bar.className = "controls";
        Object.assign(bar.style, {
            position: "absolute", bottom: "8px", left: "50%", transform: "translateX(-50%)",
            display: "flex", alignItems: "center", gap: "6px", background: "rgba(0,0,0,0.65)",
            padding: "6px 10px", borderRadius: "6px", fontFamily: "sans-serif", fontSize: "12px", color: "#ddd",
        } as CSSStyleDeclaration);
        this.container.appendChild(bar);

        const mk = (label: string, title: string, fn: () => void) => {
            const b = document.createElement("button");
            b.textContent = label; b.title = title;
            Object.assign(b.style, { background: "#1b2240", color: "#dfe6f5", border: "1px solid #33406b",
                borderRadius: "4px", padding: "2px 8px", cursor: "pointer", fontSize: "13px" } as CSSStyleDeclaration);
            b.onclick = fn; bar.appendChild(b); return b;
        };
        mk("⏮", "Jump to start", () => { this.daysSinceJ2000 = this.simMinDays; this.refreshScrubber(); });
        mk("⏪", "Rewind", () => { this.playDir = -1; this.paused = false; this.updatePlayBtn(); });
        this.playBtn = mk("⏸", "Play / Pause", () => { this.paused = !this.paused; this.updatePlayBtn(); });
        mk("⏩", "Forward", () => { this.playDir = 1; this.paused = false; this.updatePlayBtn(); });
        mk("⏭", "Jump to end", () => { this.daysSinceJ2000 = this.simMaxDays; this.refreshScrubber(); });

        this.scrubber = document.createElement("input");
        this.scrubber.type = "range"; this.scrubber.min = "0"; this.scrubber.max = "1000"; this.scrubber.value = "0";
        this.scrubber.style.width = "180px"; this.scrubber.style.cursor = "pointer";
        this.scrubber.addEventListener("mousedown", () => { this.isScrubbing = true; });
        this.scrubber.addEventListener("mouseup", () => { this.isScrubbing = false; });
        this.scrubber.addEventListener("input", () => {
            const frac = +this.scrubber.value / 1000;
            this.daysSinceJ2000 = this.simMinDays + frac * (this.simMaxDays - this.simMinDays);
        });
        bar.appendChild(this.scrubber);

        this.dateLabel = document.createElement("span");
        Object.assign(this.dateLabel.style, { minWidth: "78px", fontFamily: "monospace", color: "#9fb0d8" } as CSSStyleDeclaration);
        this.dateLabel.textContent = "—";
        bar.appendChild(this.dateLabel);
    }

    private updatePlayBtn(): void { if (this.playBtn) this.playBtn.textContent = this.paused ? "▶" : "⏸"; }
    private refreshScrubber(): void {
        if (!this.scrubber) return;
        const frac = (this.daysSinceJ2000 - this.simMinDays) / (this.simMaxDays - this.simMinDays);
        if (!this.isScrubbing) this.scrubber.value = String(Math.round(frac * 1000));
        if (this.dateLabel) this.dateLabel.textContent = this.dayToDate(this.daysSinceJ2000);
    }

    // -----------------------------------------------------------------------
    public destroy(): void {
        if (this.rafId !== null) cancelAnimationFrame(this.rafId);
        this.renderer.dispose();
    }
}
