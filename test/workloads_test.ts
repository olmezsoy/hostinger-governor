import { assertEquals, assertThrows } from "@std/assert";
import { governedDockerConfig, serviceDropIn } from "../src/workloads.ts";

Deno.test("Docker configuration preserves unrelated settings and routes containers into the managed slice", () => {
  const original = {
    "log-driver": "local",
    "exec-opts": ["native.cgroupdriver=cgroupfs", "other=value"],
  };
  const next = governedDockerConfig(original);
  assertEquals(next, {
    "log-driver": "local",
    "exec-opts": ["other=value", "native.cgroupdriver=systemd"],
    "cgroup-parent": "user.slice",
  });
  assertEquals(original["exec-opts"][0], "native.cgroupdriver=cgroupfs");
  assertEquals(governedDockerConfig(next), next);
  assertThrows(() => governedDockerConfig({ "exec-opts": "invalid" }));
});

Deno.test("service enrollment accepts service names and rejects traversal or enrolling the governor itself", () => {
  assertEquals(
    serviceDropIn("cron.service"),
    "/etc/systemd/system/cron.service.d/50-governor.conf",
  );
  assertEquals(
    serviceDropIn("build@worker.service"),
    "/etc/systemd/system/build@worker.service.d/50-governor.conf",
  );
  for (
    const unit of [
      "../cron.service",
      "/cron.service",
      "user.slice",
      "governor.service",
      "x\n.service",
    ]
  ) assertThrows(() => serviceDropIn(unit));
});
