export function admittedStart<T>(admit: (() => () => void) | undefined, start: () => T): T {
  const cancel = admit?.();
  try {
    return start();
  } catch (error) {
    cancel?.();
    throw error;
  }
}
