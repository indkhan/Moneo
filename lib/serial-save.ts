export function serialSave<T>(read: () => T, save: (value: T) => Promise<unknown>) {
  let running: Promise<void> | null = null;
  let again = false;
  async function drain() {
    try {
      do { again = false; await save(read()); } while (again);
    } finally { running = null; }
  }
  return () => {
    if (running) { again = true; return running; }
    running = drain();
    return running;
  };
}
