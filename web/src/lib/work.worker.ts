// Dedicated worker for proof-of-work generation. Running nano-pow off the
// main thread keeps the UI responsive: its WebGL path issues blocking GPU
// readbacks that would otherwise freeze the page for the whole search.
import NanoPow from "nano-pow";

self.onmessage = async (event: MessageEvent<{ id: number; hash: string; difficulty: string }>) => {
  const { id, hash, difficulty } = event.data;
  try {
    const result = await NanoPow.work_generate(hash, {
      difficulty: BigInt("0x" + difficulty.toLowerCase()),
    });
    const work = result && "work" in result ? result.work : null;
    self.postMessage({ id, work });
  } catch {
    self.postMessage({ id, work: null });
  }
};
