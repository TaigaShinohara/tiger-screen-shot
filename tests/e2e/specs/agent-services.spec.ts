import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

const fixture = `
import {setAppStoreCredentials} from '@/lib/publish/credentials';
import {readMeta,writeMeta,writeReviews,readReviewMarks,updateReviewMarks,writeListing} from '@/lib/growth/db';
import {getKeywordTracking,trackStoreKeywords,untrackStoreKeyword,setStoreReviewDone,getStoreListingDrafts,updateStoreListingDrafts} from '@/lib/growth/agentActions';
import {setListingChangesStrict,discardListingDrafts,listingDraftsKey} from '@/lib/growth/listingDrafts';
import {setSession} from '@/lib/account/store';
import {db} from '@/database';
import {pauseProjectAccountSync} from '@/lib/account/agentSync';
import {newDraft,factsFromProject} from '@/lib/website/content';
import {writeSiteRow,readSiteRow} from '@/lib/website/store';
import {getWebsiteDraft,updateWebsiteDraft} from '@/lib/website/agent';
window.runAgentFixture=async()=>{
 const check=(x,msg)=>{if(!x)throw new Error(msg)};
 setAppStoreCredentials({issuerId:'fixture-issuer',keyId:'fixture-key',privateKey:'fixture-only'});
 await writeMeta('apps:list:fixture-issuer:fixture-key',[{id:'123456',name:'Fixture',bundleId:'test.fixture'}]);
 const first=await trackStoreKeywords({appId:'123456',terms:[' Puzzle '],countries:['US']});
 check(first.dryRun===true && first.added[0]==='puzzle','keyword preview');
 check((await getKeywordTracking({appId:'123456'})).keywords.length===0,'preview wrote keywords');
 await trackStoreKeywords({appId:'123456',terms:['Puzzle'],countries:['US'],dryRun:false,confirmed:true});
 const remove=await untrackStoreKeyword({appId:'123456',term:'puzzle'});
 const list=await getKeywordTracking({appId:'123456'});
 await writeMeta('keywords:list:123456',{owner:'123456',countries:['US'],keywords:[{...list.keywords[0],id:'replacement-id'}]});
 let stale=false; try{await untrackStoreKeyword({appId:'123456',term:'puzzle',...remove,dryRun:false,confirmed:true});}catch{stale=true}
 check(stale && (await getKeywordTracking({appId:'123456'})).keywords.length===1,'stale keyword removal');
 const next=await untrackStoreKeyword({appId:'123456',term:'puzzle'});
 await untrackStoreKeyword({appId:'123456',term:'puzzle',...next,dryRun:false,confirmed:true});
 check((await getKeywordTracking({appId:'123456'})).keywords.length===0,'keyword removal');
 await writeReviews([{id:'review-fixture',appId:'123456',createdDate:'2026-11-24',rating:5,title:'Hello',body:'Example',territory:'US'}]);
 const review=await setStoreReviewDone({appId:'123456',reviewId:'review-fixture',done:true});
 check((await readReviewMarks(['123456'])).length===0,'review preview wrote data');
 await updateReviewMarks([{id:'review-fixture',appId:'123456'}],()=>({id:'review-fixture',appId:'123456',tags:['tag'],updatedAt:4}));
 let reviewStale=false; try{await setStoreReviewDone({appId:'123456',reviewId:'review-fixture',done:true,...review,dryRun:false,confirmed:true});}catch{reviewStale=true}
 check(reviewStale,'stale review mark');
 const review2=await setStoreReviewDone({appId:'123456',reviewId:'review-fixture',done:true});
 await setStoreReviewDone({appId:'123456',reviewId:'review-fixture',done:true,...review2,dryRun:false,confirmed:true});
 const marked=(await readReviewMarks(['123456']))[0]; check(!!marked.doneAt && marked.tags[0]==='tag','review mark and tags');
 await writeListing({appId:'123456',versionId:'v1',versionString:'1',state:'PREPARE_FOR_SUBMISSION',platform:'IOS',editable:true,appInfoEditable:true,primaryLocale:'en-US',fetchedAt:1000,locales:[{locale:'en-US',name:'Old',subtitle:'Old subtitle',keywords:'',promotionalText:'',description:'',whatsNew:''}]});
 const listingPlan=await updateStoreListingDrafts({appId:'123456',changes:[{locale:'en-US',field:'name',after:'New'}]});
 check((await getStoreListingDrafts({appId:'123456'})).changes.length===0,'listing preview wrote data');
 await setListingChangesStrict('123456',[{locale:'en-US',field:'subtitle',before:'Old subtitle',after:'Edited'}]);
 let listingStale=false; try{await updateStoreListingDrafts({appId:'123456',changes:[{locale:'en-US',field:'name',after:'New'}],...listingPlan,dryRun:false,confirmed:true});}catch{listingStale=true}
 check(listingStale,'stale listing draft');
 const listingPlan2=await updateStoreListingDrafts({appId:'123456',changes:[{locale:'en-US',field:'name',after:'New'}]});
 await updateStoreListingDrafts({appId:'123456',changes:[{locale:'en-US',field:'name',after:'New'}],...listingPlan2,dryRun:false,confirmed:true});
 check((await getStoreListingDrafts({appId:'123456'})).changes.length===2,'listing drafts retained');
 setSession({provider:'github',account:{id:'account-fixture',name:'Fixture'},accessToken:'secret-fixture'});
 await db.accountLinks.put({projectId:'p1',provider:'github',accountId:'account-fixture',remoteId:'secret-remote',stamp:'s',docHash:null,savedAt:new Date(1000),lastPushedName:'Fixture',autoSync:true});
 const pause=await pauseProjectAccountSync({projectId:'p1'});
 await db.accountLinks.update('p1',{remoteId:'replacement-remote'});
 let conflict=false; try{await pauseProjectAccountSync({projectId:'p1',...pause,dryRun:false,confirmed:true});}catch{conflict=true}
 check(conflict && (await db.accountLinks.get('p1')).autoSync===true,'stale sync pause');
 const pause2=await pauseProjectAccountSync({projectId:'p1'});
 const paused=await pauseProjectAccountSync({projectId:'p1',...pause2,dryRun:false,confirmed:true});
 check((await db.accountLinks.get('p1')).autoSync===false && !JSON.stringify(paused).includes('secret'),'sync pause');
 const site=newDraft({projectId:'p1',facts:factsFromProject('Fixture'),theme:{source:'default',brand:'#111111',brand2:'#222222',accent:'#333333',headingFont:'',headingWeight:700},captions:[],baseLocale:'en-US',languages:[],now:1});
 await writeSiteRow(site,[]); const before=await getWebsiteDraft('p1');
 const plan=await updateWebsiteDraft({projectId:'p1',changes:{headline:'A new headline'}});
 check((await readSiteRow('p1')).draft.content.headline===site.content.headline,'website preview wrote data');
 await updateWebsiteDraft({projectId:'p1',changes:{headline:'A new headline'},...plan,dryRun:false,confirmed:true});
 const after=await getWebsiteDraft('p1'); check(after.draft.content.headline==='A new headline' && before.revision!==after.revision,'website update');
 const pendingWrite=setListingChangesStrict('123456',[{locale:'en-US',field:'name',before:'Old',after:'Pending'}]);
 const removal=discardListingDrafts('123456');
 await Promise.all([pendingWrite,removal]);
 check(!(await readMeta(listingDraftsKey('123456'))),'discard waits for pending draft writes');
 const oldWrite=setListingChangesStrict('123456',[{locale:'en-US',field:'name',before:'Old',after:'Before removal'}]);
 const removal2=discardListingDrafts('123456');
 const newWrite=setListingChangesStrict('123456',[{locale:'en-US',field:'name',before:'Old',after:'After removal'}]);
 await Promise.all([oldWrite,removal2,newWrite]);
 check((await readMeta(listingDraftsKey('123456')))[0].after==='After removal','new draft follows removal');
 return 'ok';
};`;

test('agent operations use isolated browser storage and reject stale previews', async ({ page }) => {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return ['localhost', '127.0.0.1'].includes(url.hostname) ? route.continue() : route.abort();
  });
  const bundled = await build({
    stdin: { contents: fixture, resolveDir: process.cwd(), sourcefile: 'agent-fixture.ts', loader: 'ts' },
    bundle: true, write: false, platform: 'browser', format: 'iife',
    alias: { '@': path.join(process.cwd(), 'src') }, logLevel: 'silent',
  });
  await page.goto('/');
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  const result = await page.evaluate(() => (window as unknown as { runAgentFixture: () => Promise<string> }).runAgentFixture());
  expect(result).toBe('ok');
});
