// Database messages already written as instructions for the person reviewing.
const READABLE = /^(A refund must|Clear the |Link the internal transfer|Verify the booked amount|Release exceeds|Undo pending|Review recurring|Unarchive the account|Stored import file|Excluded source observation|Review row not found|Import transaction not found|Review history not found|Unauthorized)/;
const STALE = /changed|already (resolved|reviewed)|differs from retry|not completed|snapshot required|only the latest/i;
const ACCOUNT = /destination unavailable|account unavailable/i;

/** Turns a review failure into words a person can act on; anything unrecognized stays out of the UI. */
export function reviewErrorMessage(message: string) {
  if (READABLE.test(message)) return message;
  if (ACCOUNT.test(message)) return "That account is no longer available. Refresh the page and choose an active account in the same currency.";
  if (STALE.test(message)) return "This changed since the page loaded. Refresh the page, check it again, and retry.";
  return "This decision could not be saved, and nothing changed. Refresh the page and try again.";
}
