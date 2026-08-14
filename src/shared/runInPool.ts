export async function runInPool<T>(
  tasks: (() => Promise<T>)[],
  concurrency = 3
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  const errors: unknown[] = [];
  let index = 0;

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (index < tasks.length) {
      const currentIndex = index++;
      try {
        results[currentIndex] = await tasks[currentIndex]();
      } catch (err: unknown) {
        errors.push(err);
      }
    }
  });

  await Promise.all(workers);
  if (errors.length > 0) {
    const firstError = errors[0];
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }
  return results;
}
