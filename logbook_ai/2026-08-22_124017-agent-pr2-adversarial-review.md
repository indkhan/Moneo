# PR #2 adversarial review

- Requested: Review PR #2 adversarially and fix small bugs.
- Done: Removed the newly committed private statement from tracking while retaining the local ignored file; removed unrelated roadmap text; tightened generic merchant aliases and internal-transfer type checks; stamped new assignments with classifier v2 while retaining v1 compatibility; removed an unused matcher helper.
- Why: The PR exposed financial data, could classify P2P names as merchants, could hide unrelated memo matches from spending, and mislabeled new classifier decisions as v1.
- Validation: `npm test` passed 94/94; `npx tsc --noEmit` passed; `git diff --check` passed with only line-ending warnings.
- Remaining risk: The exposed statement remains in existing remote commit history until the branch is rewritten or the PR commits are replaced. Merchant dictionaries still require precision review as new statement formats appear.
