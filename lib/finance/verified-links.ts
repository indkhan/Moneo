import { minorDigits } from "./fx";
export type LinkRate = { id?: string; from_currency: string; to_currency: string; rate_text: string; rate_date?: string; source?: string };
export function comparisonMinor(amount: bigint, from: string, to: string, rate: LinkRate | null) {
  const fromScale=10n**BigInt(minorDigits(from)), toScale=10n**BigInt(minorDigits(to));
  if(amount<0n) throw new Error("Comparison amount must be positive");
  if(from===to) return amount;
  if(!rate || !/^\d+(?:\.\d+)?$/.test(rate.rate_text)) throw new Error("Dated FX evidence required");
  const [whole,fraction=""]=rate.rate_text.split(".");
  const rn=BigInt(whole+fraction), rd=10n**BigInt(fraction.length);
  if(rn<=0n) throw new Error("Positive FX evidence required");
  let numerator: bigint, denominator: bigint;
  if(rate.from_currency===from && rate.to_currency===to) { numerator=amount*rn*toScale; denominator=rd*fromScale; }
  else if(rate.from_currency===to && rate.to_currency===from) { numerator=amount*rd*toScale; denominator=rn*fromScale; }
  else throw new Error("FX currencies do not match the postings");
  return (2n*numerator+denominator)/(2n*denominator);
}
export function transferPrincipal(amount: bigint, fee: bigint, treatment: "included"|"additional") {
  if(fee<0n) throw new Error("Fee must be nonnegative");
  const magnitude=amount<0n?-amount:amount;
  const principal=treatment==="included" ? magnitude+(amount<0n?-fee:fee) : magnitude;
  if(principal<=0n) throw new Error("Transfer principal must be positive");
  return principal;
}
