/**
 * Memoizes an async read per database client and arguments, so the parallel readers of one request
 * (a page, or an artifact frame running several saved queries) share one round trip. Each request
 * makes its own client, so a new request reads fresh. Unlike React's cache(), this also works in route handlers.
 */
export function perClient<Client extends object, Args extends unknown[], Result>(read: (client: Client, ...args: Args) => Promise<Result>) {
  const memo = new WeakMap<Client, Map<string, Promise<Result>>>();
  return (client: Client, ...args: Args): Promise<Result> => {
    let reads = memo.get(client);
    if (!reads) memo.set(client, reads = new Map());
    const key = JSON.stringify(args);
    let result = reads.get(key);
    if (!result) reads.set(key, result = read(client, ...args));
    return result;
  };
}
