export function double(n: number): number {
  return n * 2;
}

export async function delayedSum(a: number, b: number): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return a + b;
}

export function boom(): never {
  throw new Error("module task failure");
}
