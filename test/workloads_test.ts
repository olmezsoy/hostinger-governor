import { assertEquals, assertThrows } from "@std/assert";
import {
  governedDockerConfig,
  serviceDropIn,
  serviceFound,
  serviceLookup,
} from "../src/workloads.ts";

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

Deno.test("bare templates are checked without trying to load an instance", () => {
  assertEquals(serviceLookup("xfs_scrub@.service"), ["cat", "--", "xfs_scrub@.service"]);
  assertEquals(serviceFound("xfs_scrub@.service", true, "[Service]\nExecStart=/bin/true"), true);
  assertEquals(serviceFound("xfs_scrub@.service", false, ""), false);
  assertEquals(serviceFound("xfs_scrub@.service", true, ""), false);
  assertEquals(serviceLookup("build@worker.service"), [
    "show",
    "build@worker.service",
    "--property=LoadState",
    "--value",
  ]);
  assertEquals(serviceFound("build@worker.service", true, "loaded\n"), true);
  assertEquals(serviceFound("missing.service", true, "not-found\n"), false);
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
