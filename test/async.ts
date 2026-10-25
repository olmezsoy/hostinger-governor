export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function until(predicate: () => Promise<boolean>, ms = 1000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!await predicate()) {
    if (performance.now() >= deadline) throw new Error("test deadline exceeded");
    await flush();
  }
}

export async function within<T>(promise: Promise<T>, ms = 100): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("test deadline exceeded")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
