import {expect, it} from 'vitest';
import {mergeOrganizationSuggestions, organizationDescriptionKey, organizationProposals} from './import-organization';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number, description = 'CARD PAYMENT NORTHSTAR MARKET REF:93821') => ({id: id(n), version: 1, description, merchantId: null, categoryId: null, kind: 'ordinary' as const, reviewReasons: [], userCorrected: false});
const history = [1, 2, 3].map(n => ({...row(n, `CARD PAYMENT NORTHSTAR MARKET REF:${n}`), merchantId: id(20), categoryId: id(21)}));
it('uses consistent attributable owned history for noisy unknown merchants and absent categories', () => {
  const proposals = organizationProposals([row(4)], history, []);
  expect(proposals).toMatchObject([{transactionId: id(4), version: 1, merchantId: id(20), categoryId: id(21), basis: 'consistent-history'}]);
  expect(proposals[0].evidence).toEqual(history.map(value => ({id: value.id, version: value.version})));
  expect(proposals[0]).not.toHaveProperty('amountMinor');
  expect(proposals[0]).not.toHaveProperty('kind');
});
it('keeps user corrections and explicit source organization ahead of later suggestions', () => {
  expect(organizationProposals([{...row(4), userCorrected: true}], history, [])).toEqual([]);
  expect(organizationProposals([{...row(4), merchantId: id(22), categoryId: id(23)}], history, [])).toEqual([]);
});
it('requires a consistent three-observation history and prioritizes uncertain financial meaning', () => {
  const result = organizationProposals([row(4), {...row(5, 'UNFAMILIAR TRANSFER REF:55'), reviewReasons: ['kind:unrecognized']}], history.slice(0, 2), []);
  expect(result[0]).toMatchObject({transactionId: id(5), basis: 'review-required', financialReviewRequired: true});
  expect(result.find(value => value.transactionId === id(4))).toMatchObject({basis: 'review-required', categoryId: null, merchantId: null});
});
it('does not infer a category from conflicting history', () => {
  const result = organizationProposals([row(4)], [...history, {...row(6), merchantId: id(20), categoryId: id(22)}], []);
  expect(result[0]).toMatchObject({categoryId: null, basis: 'review-required'});
});
it('makes user-approved rules take precedence over learned history without changing financial meaning', () => {
  const rule = {id: id(30), version: 2, descriptionKey: 'northstar market', merchantId: id(22), categoryId: id(23), approvedBy: id(40), enabled: true};
  const result = organizationProposals([row(4)], history, [rule]);
  expect(result[0]).toMatchObject({merchantId: id(22), categoryId: id(23), basis: 'approved-rule', rule: {id: id(30), version: 2}});
  expect(result[0]).not.toHaveProperty('kind');
});
it('rejects oversized selections and unapproved rule data before suggesting anything', () => {
  expect(() => organizationProposals(Array.from({length: 51}, (_, n) => row(n + 50)), [], [])).toThrow();
  expect(() => organizationProposals([row(4)], [], [{id: id(30), descriptionKey: 'northstar market', merchantId: id(22), categoryId: null, version: 1, enabled: true} as never])).toThrow();
});
it('preserves meaningful merchant words instead of treating them as transaction references', () => {
  expect(organizationDescriptionKey('Orderly Market')).toBe('orderly market');
  expect(organizationDescriptionKey('Payment Labs')).toBe('payment labs');
  expect(organizationDescriptionKey('REFRESH COFFEE')).toBe('refresh coffee');
});
it('offers a reviewable description-derived merchant label for unfamiliar rows without inventing categories', () => {
  expect(organizationProposals([row(4)], [], [])[0]).toMatchObject({merchantName: 'northstar market', categoryId: null, basis: 'review-required'});
});
it('accepts only selected rows, owned categories and literal source evidence from provider suggestions', () => {
  const proposals = organizationProposals([row(4)], [], []);
  const candidate = {transactionId: id(4), merchantName: 'Northstar Market', categoryId: id(21), evidenceQuote: 'NORTHSTAR MARKET'};
  const result = mergeOrganizationSuggestions([row(4)], proposals, [candidate], [id(21)]);
  expect(result[0]).toMatchObject({merchantName: 'Northstar Market', categoryId: id(21), basis: 'provider-suggestion', evidenceQuote: 'NORTHSTAR MARKET'});
  for (const invalid of [{...candidate, transactionId: id(50)}, {...candidate, categoryId: id(50)}, {...candidate, evidenceQuote: 'not in the statement'}, {...candidate, amountMinor: '9999'}, {...candidate, kind: 'transfer'}]) {
    expect(() => mergeOrganizationSuggestions([row(4)], proposals, [invalid], [id(21)])).toThrow();
  }
});
it('retains approved rules over provider suggestions and rejects proposed changes to user-corrected rows', () => {
  const rule = {id: id(30), version: 1, descriptionKey: 'northstar market', merchantId: id(22), categoryId: id(23), approvedBy: id(40), enabled: true};
  const proposals = organizationProposals([row(4)], [], [rule]);
  const candidate = {transactionId: id(4), merchantName: 'Other', categoryId: id(21), evidenceQuote: 'NORTHSTAR MARKET'};
  expect(mergeOrganizationSuggestions([row(4)], proposals, [candidate], [id(21)])[0]).toEqual(proposals[0]);
  expect(() => mergeOrganizationSuggestions([{...row(4), userCorrected: true}], [], [candidate], [id(21)])).toThrow();
});
