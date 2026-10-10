import { assertEquals, assertThrows } from "@std/assert";
import { parseReadings } from "../src/hostinger.ts";

const metric = (
  unit = "%",
  usage: Record<string, number> = { "1000": 20, "2800": 25, "4600": 30 },
) => ({ cpu_usage: { unit, usage } });
Deno.test("CPU metrics validate units, sort timestamps and discard the newest bucket", () => {
  assertEquals(parseReadings(metric(), 0, 5_000_000), [{ at: 1_000_000, v: 20 }, {
    at: 2_800_000,
    v: 25,
  }]);
  assertEquals(parseReadings(metric("percent"), 0, 5_000_000).length, 2);
});

Deno.test("malformed CPU metrics cannot become credit evidence", () => {
  assertThrows(() => parseReadings(metric("cores"), 0, 5_000_000));
  assertThrows(() => parseReadings({ cpu_usage: { usage: { "1000": 20 } } }, 0, 5_000_000));
  assertThrows(() =>
    parseReadings(metric("%", { "1000": 120, "2800": 0, "4600": 0 }), 0, 5_000_000)
  );
  assertThrows(() => parseReadings(metric("%", { "bad": 0 }), 0, 5_000_000));
  assertThrows(() => parseReadings(metric(), 0, 100));
  assertEquals(parseReadings({}, 0, 5_000_000), []);
});
