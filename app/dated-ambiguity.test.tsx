import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {resolveBalances} from '@/lib/finance/balances';
import {DatedOverview} from './dated-overview';

const accounts = [{id: 'bank', name: 'Recorded bank', currency_code: 'EUR'}];
const snapshot = {id: 'observed', account_id: 'bank', amount_minor: '50000', currency_code: 'EUR', as_of: '2026-09-30T12:00:00Z', provenance: 'import:dated'};
const asOf = '2026-10-08T12:00:00Z';
const ledger = [{id: 'uncertain', account_id: 'bank', amount_minor: '-100', currency_code: 'EUR', posted_on: '2026-09-30', status: 'posted'}];
function overview(snapshots: typeof snapshot[]) {
  const resolved = resolveBalances(accounts, snapshots, ledger, asOf, 'UTC');
  return renderToStaticMarkup(<DatedOverview accounts={resolved} wealth={[]} today='2026-10-08' locale='en-GB' />);
}
it('shows the account and its recorded amount only', () => {
  const html = overview([snapshot]);
  for (const value of ['EUR 500.00', 'Recorded bank']) expect(html).toContain(value);
  for (const value of ['import:dated', '2026-09-30', 'not verified current funds']) expect(html).not.toContain(value);
});
it('withholds conflicting original snapshots instead of choosing an arbitrary dated amount', () => {
  const html = overview([snapshot, {...snapshot, id: 'conflict', amount_minor: '60000'}]);
  expect(html).not.toContain('EUR 500.00'); expect(html).not.toContain('EUR 600.00');
});
