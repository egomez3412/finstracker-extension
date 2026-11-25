import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { capitalOneOffersPageScraper } from '../lib/inject/capital-one-offers.js';
import { addOffersToCard } from '../lib/inject/offers.js';
import { readKindForUrl, issuerForUrl } from '../lib/portals.js';
import fs from 'node:fs';
import { offerRewardLabel } from '../lib/benefits.js';

const tile = (merchant, badge, kind = 'affiliate') => `<div role="button" data-testid="feed-tile-${Buffer.from(JSON.stringify({viewContext:'opaque-do-not-save',inventory:{source:'standard',merchantTLD:'example.com'},offers:[kind]})).toString('base64')}"><div class="standard-tile"><img alt="${merchant}" src="https://images.capitaloneshopping.com/api/v1/logos?domain=example.com"><h2>${kind === 'cardLinked' ? 'In-Store' : 'Online'}</h2>\n<div>${badge}</div></div></div>`;
const slots = (used, added = '') => `<section><div><h2>Added to Card</h2><span>${used} of 3 activated</span></div>${added}<button>Activate another in-store offer</button></section>`;
function page(html) {
  const { document, window } = parseHTML(`<html><body><button disabled>Venture...4509</button>${html}</body></html>`);
  window.HTMLElement.prototype.getBoundingClientRect = () => ({width:300,height:40,top:10});
  Object.defineProperties(document.documentElement,{clientHeight:{configurable:true,value:800},scrollHeight:{configurable:true,value:800},scrollTop:{configurable:true,writable:true,value:0}});
  const context = vm.createContext({document,window,atob:s=>Buffer.from(s,'base64').toString(),setTimeout:fn=>{fn();return 1;}});
  return {document,run:(fn,...args)=>vm.runInContext(`(${fn.toString()})(${args.map(JSON.stringify).join(',')})`,context)};
}

test('Capital One merchant logos, ranges and offer types stay distinct', async () => {
  const p = page(slots(0) + tile('Amazon','Spend $20, earn $5','cardLinked') + tile('adidas','Up to 15% back') + tile('DICK’S Sporting Goods','Up to $45 back'));
  const rows = await p.run(capitalOneOffersPageScraper);
  assert.equal(rows.length,3);
  assert.equal(rows[0].merchant,'Amazon');
  assert.equal(rows[0].minSpendCents,2000);
  assert.equal(rows[0].discountValue,500);
  assert.equal(rows[0].redemptionMethod,'card_linked');
  assert.equal(rows[0].activationVerified,true);
  assert.equal(rows[0].activated,false);
  assert.equal(rows[0].activationRemaining,3);
  assert.equal(rows[1].discountUpTo,true);
  assert.equal(rows[1].discountValue,15);
  assert.equal(rows[1].redemptionMethod,'shopping_link');
  assert.equal(rows[1].activationVerified,false);
  assert.equal(rows[2].discountValue,4500);
  assert.ok(rows.every(r=>r.expiresAt === null));
  assert.ok(!JSON.stringify(rows).includes('opaque-do-not-save'));
});

test('Capital One reads activated cards outside the main feed without inventing more activations', async () => {
  const activated = '<div><div class="standard-tile"><img alt="Whole Foods In-Store"><h2>In-Store</h2><div>Spend $20, earn $5</div><div>7 days left</div></div></div>';
  const p = page(slots(1,activated) + tile('Amazon','Spend $20, earn $5','cardLinked'));
  const rows = await p.run(capitalOneOffersPageScraper);
  const wf = rows.find(r=>r.merchant.startsWith('Whole Foods'));
  assert.ok(wf.activated && wf.activationVerified);
  assert.equal(wf.activationRemaining,2);
  assert.ok(wf.expiresAt);
  assert.equal(rows.find(r=>r.merchant==='Amazon').activated,false);
  assert.equal(rows.find(r=>r.merchant==='Amazon').activationVerified,true);
});

test('Capital One only confirms membership when the complete activation list is visible', async () => {
  const p = page(slots(1) + tile('Amazon','Spend $20, earn $5','cardLinked'));
  assert.equal((await p.run(capitalOneOffersPageScraper))[0].activationVerified,false);
});

test('Capital One preserves the horizontal shopping collection without treating it as activated', async () => {
  const p=page(slots(0)+'<div role="button" data-testid="feed-tile-carousel-53"><div class="standard-tile"><img alt="eufy"><div>Up to 13% back</div></div><div class="standard-tile"><img alt="Babbel"><div>30% back</div></div></div>');
  const rows=await p.run(capitalOneOffersPageScraper);
  assert.equal(rows.length,2);
  assert.ok(rows.every(r=>r.redemptionMethod==='shopping_link'&&!r.activated));
  assert.equal(rows[0].discountUpTo,true);
});

test('Capital One reads pagination without clicking activation or shopping controls', async () => {
  const p = page(slots(0) + tile('Amazon','Spend $20, earn $5','cardLinked') + '<button id="more">View More Offers</button><button id="activate">Activate Offer</button>');
  let activated=false;
  p.document.getElementById('activate').click=()=>{activated=true;};
  p.document.getElementById('more').click=function(){this.insertAdjacentHTML('beforebegin',tile('Second Store','5% back'));this.remove();};
  const rows=await p.run(capitalOneOffersPageScraper,true);
  assert.equal(rows.length,2);
  assert.equal(activated,false);
  const result=await p.run(addOffersToCard,300);
  assert.equal(result.manualActivationRequired,true);
  assert.equal(result.added,0);
  assert.equal(activated,false);
});

test('Capital One keeps recycled scrolling windows and restores the original position', async () => {
  const p=page(slots(0)+tile('Merchant 0','5% back'));
  let position=0;
  Object.defineProperties(p.document.documentElement,{
    scrollHeight:{get:()=>5000},
    scrollTop:{get:()=>position,set:y=>{position=y;p.document.body.innerHTML=slots(0)+tile(`Merchant ${Math.floor(y/800)}`,'5% back');}},
  });
  const rows=await p.run(capitalOneOffersPageScraper,true);
  assert.equal(rows.length,6);
  assert.equal(position,0);
});

test('Capital One pagination has a fixed request cap', async () => {
  const p=page(slots(0)+tile('First','5% back')+'<button id="more">View More Offers</button>');
  let loads=0;
  p.document.getElementById('more').click=function(){loads++;this.insertAdjacentHTML('beforebegin',tile(`Page ${loads}`,'5% back'));};
  await p.run(capitalOneOffersPageScraper,true);
  assert.equal(loads,20);
});

test('Capital One rejects unknown tile kinds and classifies only its exact offer hostname', async () => {
  const p=page(tile('Referral Promotion','Earn $100','referral'));
  assert.equal((await p.run(capitalOneOffersPageScraper)).length,0);
  assert.equal(readKindForUrl('https://capitaloneoffers.com/feed'),'offers');
  assert.equal(readKindForUrl('https://capitaloneoffers.com.evil.example/feed'),'points');
  const portals=JSON.parse(fs.readFileSync(new URL('../portals.json',import.meta.url)));
  assert.equal(issuerForUrl('https://capitaloneoffers.com/feed',portals),'Capital One');
});

test('the extension labels percentages and capped shopping rewards without inventing cash values', () => {
  assert.equal(offerRewardLabel({discountType:'pct_back',discountValue:15,valueCents:750,discountUpTo:true}),'Up to 15% back');
  assert.equal(offerRewardLabel({discountType:'statement_credit',valueCents:4500,discountUpTo:true}),'Up to $45.00');
  assert.equal(offerRewardLabel({discountType:'bonus_points',discountValue:4000,valueCents:6000}),'4,000 points');
});
