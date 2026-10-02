import { expect, it } from "vitest";
import { checkOutputShape } from "./output";
it("accepts exact textual money and meaningful unavailable results",()=>{
  expect(checkOutputShape({numbers:{minor:"9007199254740993"},rows:[{name:"Source",amount:"-100"}]})).toEqual([]);
  expect(checkOutputShape({unavailable:"No dated evidence"})).toEqual([]);
});
it("rejects live renderer shapes that would crash or introduce invalid charts",()=>{
  for(const output of [{rows:"not rows"},{numbers:[]},{warning:{}},{unavailable:4},{chart:{labels:["a"],values:[Infinity]}},{chart:{labels:["a"],values:[1,2]}}]){
    expect(checkOutputShape(output)).not.toEqual([]);
  }
});
