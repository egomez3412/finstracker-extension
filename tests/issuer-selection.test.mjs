import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureShownCard,withAccount,accountParam} from '../lib/worker/sites.js';
let reading=null,last4={},wanted;
globalThis.chrome={storage:{local:{get:async()=>({cardLast4:last4})}},scripting:{executeScript:async details=>{
 if(details.files)return [];
 if(details.args?.[0]==='detectCard')return [{result:reading}];
 if(details.args?.[0]==='switchAccount'){wanted=details.args[1][0];return [{result:{ok:false,reason:'no-option'}}];}
 return [];
}}};
const card={id:'a',displayName:'Gold'};
const siteCards=[{id:'a',name:'Gold',words:['gold']},{id:'b',name:'Platinum',words:['platinum']}];
test('ambiguous issuer pages fail closed even for one-off syncs',async()=>{
 reading=null;assert.equal((await ensureShownCard(1,card,{siteCards,attempt:2})).ok,false);
 reading={id:'b',strong:true};assert.equal((await ensureShownCard(1,card,{siteCards,attempt:2})).ok,false);
 reading={id:'a',strong:true};assert.equal((await ensureShownCard(1,card,{siteCards,attempt:2})).ok,true);
});
test('benefits require selection even if the wallet has only one card',async()=>{
 reading=null;assert.equal((await ensureShownCard(1,card,{siteCards:[siteCards[0]],requireVerified:true,attempt:2})).ok,false);
});
test('known card numbers take precedence over ambiguous product names',async()=>{
 reading=null;last4={a:'1234'};await ensureShownCard(1,card,{siteCards,attempt:0});assert.deepEqual(wanted,['1234']);last4={};
});
test('benefits navigation preserves the issuer account and never sends it to another bank',()=>{
 const account={...accountParam('https://global.americanexpress.com/dashboard?account_key=card-key'),host:'americanexpress.com'};
 assert.equal(new URL(withAccount('https://global.americanexpress.com/card-benefits/activity',account)).searchParams.get('account_key'),'card-key');
 assert.equal(withAccount('https://secure.chase.com/benefits',account),'https://secure.chase.com/benefits');
});
