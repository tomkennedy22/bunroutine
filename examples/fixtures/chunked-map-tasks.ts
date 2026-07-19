export interface Item {
  id: number;
  name: string;
  position: { x: number; y: number; z: number };
  tags: string[];
}

// Stand-in for something genuinely CPU-heavy per item (parsing, regex,
// crypto, image processing, ...) — a tight loop so this example has no
// dependencies.
export function expensiveWork(item: Item): number {
  let hash = item.id;
  for (let i = 0; i < 200_000; i++) {
    hash = (hash * 31 + item.name.charCodeAt(i % item.name.length)) | 0;
  }
  return hash;
}

export function processChunk(items: Item[]): number[] {
  return items.map(expensiveWork);
}
