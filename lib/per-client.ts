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
