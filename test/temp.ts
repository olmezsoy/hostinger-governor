// Writable test data is separate from tracked, read-only fixtures.
export async function testDirectory(prefix: string): Promise<string> {
  await Deno.mkdir("test/.tmp", { recursive: true });
  return await Deno.makeTempDir({ dir: "test/.tmp", prefix });
}
