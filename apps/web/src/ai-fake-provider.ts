// E01-S05 recording fake provider: the test transport E02-S04/E04-S01
// replace with the qualified OpenRouter path. Records hashes + ids +
// versions only (never names/amounts) and carries a caller-supplied sentinel
// tripwire so tests fail loudly if the gate ever leaks excluded data. The
// tripwire is a test double aid, not a security boundary.

import type { EligibleSelection } from "./ai-policy.ts";
import { fingerprintEligible } from "./ai-policy.ts";

export type FakeSendRecord = {
  purpose: string;
  policyVersion: string;
  eligibleAccountIds: string[];
  payloadHash: string;
  at: string;
};

export type FakeProvider = {
  send: (selection: EligibleSelection, purpose: string, sentinels?: string[]) => FakeSendRecord;
  log: () => FakeSendRecord[];
};

export function createFakeProvider(maxRecords = 200): FakeProvider {
  const records: FakeSendRecord[] = [];
  return {
    send(selection, purpose, sentinels = []) {
      const serialized = JSON.stringify({ accounts: selection.accounts, provenance: selection.provenance, purpose });
      for (const sentinel of sentinels) {
        if (sentinel && serialized.includes(sentinel)) {
          throw new Error("fake_provider_tripwire: excluded sentinel reached the transport");
        }
      }
      const record: FakeSendRecord = {
        purpose,
        policyVersion: selection.provenance.policyVersion,
        eligibleAccountIds: [...selection.provenance.eligibleAccountIds],
        payloadHash: fingerprintEligible(selection, purpose),
        at: new Date().toISOString(),
      };
      records.push(record);
      while (records.length > maxRecords) records.shift();
      return record;
    },
    log: () => [...records],
  };
}
