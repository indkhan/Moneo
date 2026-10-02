import { test, expect } from "@playwright/test";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";
const state=e2eStorageStatePath(); if(state) test.use({storageState:state});
test.skip(!hasSupabaseEnv()||!state,gatedSkipReason());
test("dated FX transfer keeps canonical source and an included fee through guarded pair undo",async({page})=>{
  test.setTimeout(180_000);
  const suffix=crypto.randomUUID().slice(0,8); const rateDate=new Date(Date.UTC(2000,0,1)+(parseInt(suffix,16)%9000)*86400000).toISOString().slice(0,10); const accounts=[`FX EUR QA ${suffix}`,`FX USD QA ${suffix}`]; const descriptions=[`FX debit QA ${suffix}`,`FX credit QA ${suffix}`]; const source=`FX link QA ${suffix}`;
  for(const [index,account] of accounts.entries()) {
    await page.goto("/"); await page.getByRole("textbox",{name:"Account name",exact:true}).fill(account);
    await page.getByRole("textbox",{name:"Currency code",exact:true}).fill(index?"USD":"EUR");
    await page.getByRole("button",{name:"Add account",exact:true}).click(); await expect(page.getByRole("heading",{name:account,exact:true})).toBeVisible({timeout:30_000});
  }
  await page.goto("/plan/currency");
  await page.getByRole("combobox",{name:"From currency",exact:true}).fill("EUR"); await page.getByRole("combobox",{name:"To currency",exact:true}).fill("USD");
  await page.getByRole("textbox",{name:"Rate",exact:true}).fill("1.1"); await page.getByRole("textbox",{name:"Rate source",exact:true}).fill(source);
  await page.getByLabel("Rate date",{exact:true}).fill(rateDate); await page.getByRole("button",{name:"Add rate",exact:true}).click();
  await expect(page.getByRole("listitem").filter({hasText:source})).toBeVisible({timeout:30_000});
  const urls:string[]=[];
  for(const [index,description] of descriptions.entries()) {
    await page.goto("/money/transactions"); await page.getByText("Add a manual transaction",{exact:true}).click();
    const manual=page.locator("form").filter({has:page.getByRole("button",{name:"Add transaction",exact:true})});
    await manual.getByRole("combobox",{name:"Account",exact:true}).selectOption({label:`${accounts[index]} (${index?"USD":"EUR"})`});
    await manual.getByLabel("Description",{exact:true}).fill(description); await manual.getByLabel("Signed decimal amount").fill(index?"110.00":"-101.00");
    await manual.getByRole("button",{name:"Add transaction",exact:true}).click(); await page.waitForURL(/transaction=[0-9a-f-]{36}/,{timeout:30_000}); urls.push(page.url());
  }
  await page.goto(urls[0]); const detail=page.getByRole("complementary",{name:"Transaction details"});
  const form=detail.locator("form").filter({has:page.getByRole("heading",{name:"Verified transfer",exact:true})});
  const counterpart=form.getByRole("combobox",{name:"Transfer counterpart",exact:true});
  const candidateValue=await counterpart.locator("option").filter({hasText:descriptions[1]}).getAttribute("value"); await counterpart.selectOption(candidateValue!);
  const rate=form.getByRole("combobox",{name:"Dated FX evidence",exact:true}); const rateValue=await rate.locator("option").filter({hasText:source}).getAttribute("value"); await rate.selectOption(rateValue!);
  const fee=form.locator("fieldset").first(); await fee.getByRole("textbox",{name:"Fee amount",exact:true}).fill("1.00"); await fee.getByRole("textbox",{name:"Fee source evidence",exact:true}).fill("Explicit 1.00 EUR fee included in debit source");
  await expect(form.getByRole("status")).toContainText("EUR 1.00"); await form.getByRole("checkbox").check(); await form.getByRole("button",{name:"Confirm verified transfer",exact:true}).click();
  await expect(detail.getByText("Transfer pair:",{exact:false})).toBeVisible({timeout:30_000}); await expect(detail.locator('pre[aria-label="Original source evidence"]')).toContainText('"amount_minor": "-10100"');
  await detail.getByRole("button",{name:"Undo verified link",exact:true}).click(); await expect(detail.getByRole("heading",{name:"Verified transfer",exact:true})).toBeVisible({timeout:30_000});
  await expect(detail.locator('pre[aria-label="Original source evidence"]')).toContainText('"amount_minor": "-10100"');
  const refundDescriptions=[`Original USD purchase QA ${suffix}`,`Partial EUR refund one QA ${suffix}`,`Partial EUR refund two QA ${suffix}`]; const refundUrls:string[]=[];
  for(const [index,description] of refundDescriptions.entries()) {
    await page.goto("/money/transactions"); await page.getByText("Add a manual transaction",{exact:true}).click();
    const manual=page.locator("form").filter({has:page.getByRole("button",{name:"Add transaction",exact:true})});
    await manual.getByRole("combobox",{name:"Account",exact:true}).selectOption({label:`${accounts[index?0:1]} (${index?"EUR":"USD"})`});
    await manual.getByLabel("Description",{exact:true}).fill(description); await manual.getByLabel("Posting date",{exact:true}).fill(index?"2026-10-02":"2026-09-01");
    await manual.getByLabel("Signed decimal amount").fill(index?"50.00":"-110.00"); await manual.getByRole("button",{name:"Add transaction",exact:true}).click();
    await page.waitForURL(/transaction=[0-9a-f-]{36}/,{timeout:30_000}); refundUrls.push(page.url());
  }
  for(const url of refundUrls.slice(1)) {
    await page.goto(`${url}&linkSearch=${encodeURIComponent(refundDescriptions[0])}`); const refundForm=detail.locator("form").filter({has:page.getByRole("heading",{name:"Verified refund",exact:true})});
    const originals=refundForm.getByRole("combobox",{name:"Refund original",exact:true}); const originalValue=await originals.locator("option").filter({hasText:refundDescriptions[0]}).getAttribute("value"); await originals.selectOption(originalValue!);
    await refundForm.getByRole("combobox",{name:"Dated FX evidence",exact:true}).selectOption(rateValue!); await expect(refundForm.getByRole("status")).toContainText("USD 55.00");
    await refundForm.getByRole("checkbox").check(); await refundForm.getByRole("button",{name:"Confirm verified refund",exact:true}).click();
    await expect(detail.getByText("Refund of:",{exact:false})).toBeVisible({timeout:30_000}); await expect(detail.locator('pre[aria-label="Original source evidence"]')).toContainText('"currency_code": "EUR"');
  }
  await page.goto(refundUrls[0]); await expect(detail.getByText(refundDescriptions[1],{exact:false})).toBeVisible(); await expect(detail.getByText(refundDescriptions[2],{exact:false})).toBeVisible();
  for(const url of refundUrls.slice(1)) {
    await page.goto(url); await detail.getByRole("button",{name:"Undo verified link",exact:true}).click(); await expect(detail.getByRole("heading",{name:"Verified refund",exact:true})).toBeVisible({timeout:30_000});
    await expect(detail.locator('pre[aria-label="Original source evidence"]')).toContainText('"amount_minor": "5000"');
  }
});
