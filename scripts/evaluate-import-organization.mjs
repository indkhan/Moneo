// Run: node --experimental-strip-types scripts/evaluate-import-organization.mjs
// Frozen synthetic holdout; no environment, database, auth or provider access.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {organizationDescriptionKey,organizationProposals} from '../lib/import-organization.ts';

const cases=JSON.parse(readFileSync(new URL('./fixtures/import-organization-holdout.json',import.meta.url),'utf8'));
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let suggestedFields=0,correctFields=0,reviewRequired=0,suppressed=0,completeSuggestions=0,financialReview=0,missingTargetDecisions=0;
const results=[];
for(const [index,fixture] of cases.entries()) {
  const selected={id:id(1000+index),version:3,description:fixture.description,merchantId:null,categoryId:null,kind:'ordinary',reviewReasons:fixture.reviewReasons??[],userCorrected:fixture.userCorrected??false};
  const history=fixture.history.map((description,n)=>({...selected,id:id(100+index*10+n),description,userCorrected:false,reviewReasons:[],merchantId:id(fixture.targets[n][0]),categoryId:id(fixture.targets[n][1])}));
  const rules=fixture.rule?[{id:id(500+index),version:2,descriptionKey:organizationDescriptionKey(selected.description),merchantId:id(fixture.rule.merchant),categoryId:id(fixture.rule.category),approvedBy:id(900),enabled:true}]:[];
  const [proposal]=organizationProposals([selected],history,rules);
  if(fixture.expectedSuppressed){assert.equal(proposal,undefined,fixture.name);suppressed++;results.push({name:fixture.name,outcome:'user-correction-retained'});continue;}
  assert.ok(proposal,fixture.name);
  assert.equal(proposal.basis,fixture.expectedBasis,fixture.name);
  assert.equal(proposal.financialReviewRequired,fixture.expectedFinancialReview??false,fixture.name);
  for(const [field,expected] of [['merchantId',fixture.expectedMerchant],['categoryId',fixture.expectedCategory]]) {
    const target=expected===null?null:id(expected);
    if(proposal[field]!==null){suggestedFields++;if(proposal[field]===target)correctFields++;}
    assert.equal(proposal[field],target,`${fixture.name}: ${field}`);
  }
  assert.equal('amountMinor' in proposal,false);assert.equal('kind' in proposal,false);
  for(const evidence of proposal.evidence)assert.ok(history.some(row=>row.id===evidence.id && row.version===evidence.version));
  if(proposal.basis==='review-required')reviewRequired++;
  if(proposal.merchantId && proposal.categoryId)completeSuggestions++;
  if(proposal.financialReviewRequired)financialReview++;
  missingTargetDecisions+=Number(proposal.merchantId===null)+Number(proposal.categoryId===null);
  results.push({name:fixture.name,basis:proposal.basis,merchantSuggested:proposal.merchantId!==null,categorySuggested:proposal.categoryId!==null,financialReviewRequired:proposal.financialReviewRequired});
}
console.log(JSON.stringify({scope:'synthetic deterministic organization holdout; every proposal still requires user review',cases:cases.length,suggestedFields,correctFields,incorrectFields:suggestedFields-correctFields,fieldPrecision:suggestedFields?correctFields/suggestedFields:null,completeSuggestions,reviewRequired,financialReview,suppressedUserCorrections:suppressed,reviewEffort:{proposalRows:cases.length-suppressed,rowsRequiringMissingTargetDecisions:reviewRequired,missingTargetDecisions,baselineMissingTargetDecisions:2*(cases.length-suppressed)},limits:'Not live provider quality, personalization persistence, automatic acceptance calibration, or measured human review time.',results},null,2));
