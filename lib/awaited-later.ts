const reportedWhereAwaited = () => undefined;

export function awaitedLater<T>(promise: Promise<T>): Promise<T> {
  promise.catch(reportedWhereAwaited);
  return promise;
}
