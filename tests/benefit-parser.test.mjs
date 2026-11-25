import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';
const context=vm.createContext({window:{}});
vm.runInContext(readFileSync(new URL('../content/benefit-parser.js',import.meta.url),'utf8'),context);
const parse=(title,text)=>context.window.__finsBenefitParser.parse(title,text,'2026-11-24');
test('current month usage is distinct from year-to-date totals',()=>{
 const b=parse('$300 Digital Entertainment Credit','Earned This Year: $266.96 $25 Earned Nov $0 To Go');
 assert.equal(b.total,25);assert.equal(b.used,25);assert.equal(b.periodStart,'2026-11-01');assert.equal(b.periodEnd,'2026-11-30');
});
test('zero usage and semiannual credits retain their current allowance',()=>{
 const b=parse('$600 Lodging Credit','$300 Earned This Year $0 Earned Jul – Dec $300 To Go');
 assert.equal(b.used,0);assert.equal(b.total,300);assert.equal(b.periodStart,'2026-07-01');assert.equal(b.periodEnd,'2026-12-31');
});
test('partial annual usage is saved accurately',()=>{
 const b=parse('$219 CLEAR+ Credit','Annual credit. $209 Earned $10 To Go');
 assert.equal(b.total,219);assert.equal(b.used,209);assert.equal(b.remaining,10);assert.equal(b.fullyUsed,false);
});
test('discovered benefits do not invent usage or ignore enrollment',()=>{
 const b=parse('$84 Dunkin Credit','Get $7 back each month. Enrollment required.');
 assert.equal(b.total,7);assert.equal(b.usageKnown,false);assert.equal(b.enrollment,'required');
});
test('old monthly progress never becomes current usage',()=>{
 const b=parse('$300 Digital Entertainment Credit','Get up to $25 per month. $25 Earned Oct $0 To Go');
 assert.equal(b.usageKnown,false);assert.equal(b.used,null);assert.equal(b.remaining,null);
});
test('spend thresholds and multi-year credits are not annual cash allowances',()=>{
 assert.equal(parse('The Centurion Lounge Complimentary Guest Access','$5,677 Earned $69,323 To Go this year'),null);
 assert.equal(parse('Global Entry Credit','Receive $120 credit every 4 years'),null);
});
test('reader keeps benefit tiles separate and recognizes the selected card combobox',()=>{
 const {window}=parseHTML('<html><body><div role="combobox" aria-label="Open to manage your other accounts">Blue Cash Everyday ••••21000</div><section><h2>$84 Disney Credit</h2><p>Get $7 back per month. Enrollment required.</p></section><section><h2>$180 Home Chef Credit</h2><p>Get $15 back per month.</p></section><div id="fins-status-root"><h2>$900 Fake Credit</h2>Annual credit. $900 earned $0 remaining</div></body></html>');
 delete window.__finsReader;
 window.HTMLElement.prototype.getBoundingClientRect=()=>({width:300,height:40,top:20});
 const ctx=vm.createContext({window,document:window.document,scrollY:0,getComputedStyle:()=>({display:'block',visibility:'visible'}),setTimeout,clearTimeout,location:{href:'https://example.test/benefits'}});
 vm.runInContext(readFileSync(new URL('../content/benefit-parser.js',import.meta.url),'utf8'),ctx);
 vm.runInContext(readFileSync(new URL('../content/reader.js',import.meta.url),'utf8'),ctx);
 const benefits=window.__finsReader.readBenefits();
 assert.equal(benefits.length,2);assert.ok(benefits.every(b=>!b.title.includes('Fake')));
 const shown=window.__finsReader.detectCard([{id:'blue',words:['blue','cash','everyday']},{id:'platinum',words:['platinum']}]);
 assert.equal(shown.id,'blue');assert.equal(shown.strong,true);
});
test('Amex account selection opens a combobox even without button or popup attributes',async()=>{
 const {window}=parseHTML('<html><body><div role="combobox" aria-label="Open to manage your other accounts">Platinum Card</div></body></html>');
 delete window.__finsReader;
 window.HTMLElement.prototype.getBoundingClientRect=()=>({width:300,height:40,top:20});
 let selected=false;
 window.document.querySelector('[role=combobox]').click=()=>{
  const option=window.document.createElement('div');option.setAttribute('role','option');option.textContent='Gold Card';option.click=()=>{selected=true;};window.document.body.append(option);
 };
 const ctx=vm.createContext({window,document:window.document,scrollY:0,getComputedStyle:()=>({visibility:'visible'}),setTimeout:fn=>{fn();},location:{href:'https://example.test/benefits'}});
 vm.runInContext(readFileSync(new URL('../content/reader.js',import.meta.url),'utf8'),ctx);
 assert.equal((await window.__finsReader.switchAccount(['gold'],[['platinum']])).clicked,true);assert.equal(selected,true);
});
test('Oura each-year wording keeps the visible annual allowance and zero usage',()=>{
 const b=parse('$200 Oura Ring Credit','$0 Earned $200 To Go Receive up to $200 back each year when you use your Platinum Card to purchase an Oura Ring through Oura. Enrollment required.');
 assert.equal(b.total,200);assert.equal(b.used,0);assert.equal(b.remaining,200);assert.equal(b.cadence,'annual');
});


test('Atmos balance selector reads available points instead of status progress', () => {
 const portals=JSON.parse(readFileSync(new URL('../portals.json',import.meta.url),'utf8'));
 const {window}=parseHTML('<html><body><section><h2>Status points earned this year</h2><strong>3,245</strong></section><div class="points-header"><div class="points-label">Available Points</div><div class="points-value display-sm">9,607</div></div></body></html>');
 delete window.__finsReader;
 window.HTMLElement.prototype.getBoundingClientRect=()=>({width:300,height:40,top:20});
 const ctx=vm.createContext({window,Element:window.Element,document:window.document,scrollY:0,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),setTimeout,clearTimeout,location:{href:'https://www.alaskaair.com/atmosrewards/account/overview/'}});
 vm.runInContext(readFileSync(new URL('../content/reader.js',import.meta.url),'utf8'),ctx);
 for(const selector of [portals.issuers['Alaska Airlines'].selector,portals.cards['alaska-mileage-plan-visa'].selector]) {
  const result=window.__finsReader.extract(selector,null,'points',{});
  assert.equal(result.text,'9,607');assert.equal(result.via,'selector');
 }
});
