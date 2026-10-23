// Prints the polyline points for the two charts in docs/how-it-works.svg. The curves come from the
// real spend law: KVM 8, a full estimate, work that wants every core, 0.2 cores outside user.slice and
// a pass every 30 seconds. The "no governor" line runs every core until the same billing empties the
// bank, then holds at Hostinger's limit. Rerun it when src/credits.ts or src/plans.ts changes.
//
//   deno run --allow-read=src tools/diagram-curves.ts
import { allowedCores, creditStep, LAW, MARGIN, sliceCeiling } from "../src/credits.ts";
import { plan } from "../src/plans.ts";

// Chart geometry in the SVG: x from 84 to 300 spans four hours; heights are 44 and 48.
const X0 = 84;
const WIDTH = 216;
const MINUTES = 240;
const ESTIMATE_HEIGHT = 44;
const CPU_HEIGHT = 48;
const OUTSIDE_CORES = 0.2;
const PASS_SECONDS = 30;

type Point = [number, number];
const round = (v: number) => Math.round(v * 10) / 10;
const x = (seconds: number) => round(X0 + (seconds / 60 / MINUTES) * WIDTH);

// Drop points within 0.05 px of the line through their neighbours.
function simplify(points: Point[]): string {
  const kept = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [ax, ay] = kept.at(-1)!;
    const [bx, by] = points[i];
    const [cx, cy] = points[i + 1];
    const offset = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) /
      Math.hypot(cx - ax, cy - ay);
    if (offset > 0.05) kept.push(points[i]);
  }
  kept.push(points.at(-1)!);
  return kept.map(([px, py]) => `${px},${py}`).join(" ");
}

const p = plan(8);
const estimate: Point[] = [];
const cpu: Point[] = [];
let balance = p.capacity;
for (let t = 0; t <= MINUTES * 60; t += PASS_SECONDS) {
  const ceiling = sliceCeiling(p, allowedCores(p, balance, MARGIN, LAW), OUTSIDE_CORES);
  const busy = Math.min(p.vcpus, ceiling / 100 + OUTSIDE_CORES);
  if (t % 150 === 0) {
    estimate.push([x(t), round(ESTIMATE_HEIGHT * (1 - balance / p.capacity))]);
    cpu.push([x(t), round(CPU_HEIGHT * (1 - busy / p.vcpus))]);
  }
  balance = creditStep(p, balance, busy, PASS_SECONDS, MARGIN);
}

let bank = p.capacity;
let empty = 0;
while (bank > 0) {
  bank = creditStep(p, bank, p.vcpus, 1, MARGIN);
  empty++;
}
const drop = x(empty);
const limited = round(CPU_HEIGHT * (1 - p.limit / p.vcpus));

console.log(`credit estimate: ${simplify(estimate)}`);
console.log(`20% floor y: ${round(ESTIMATE_HEIGHT * (1 - LAW.floor))}`);
console.log(`governor vCPUs: ${simplify(cpu)}`);
console.log(
  `no governor credits: ${X0},0 ${drop},${ESTIMATE_HEIGHT} ${X0 + WIDTH},${ESTIMATE_HEIGHT}`,
);
console.log(`no governor vCPUs: ${X0},0 ${drop},0 ${drop},${limited} ${X0 + WIDTH},${limited}`);
console.log(`host limit y: ${limited}`);
console.log(
  `settles at ${round(p.vcpus * (1 - cpu.at(-1)![1] / CPU_HEIGHT))} vCPU; ` +
    `no governor empties the bank after ${round(empty / 60)} min and holds at ${p.limit} vCPU`,
);
