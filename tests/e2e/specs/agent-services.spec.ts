import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

const fixture = `
import {getStoreCredentials,setAppStoreCredentials} from '@/lib/publish/credentials';
import {readListing,readMeta,writeMeta,readReviews,writeReviews,readReviewMarks,updateReviewMarks,writeListing,readReviewReplyDraft,removeReviewReplyDraftIfSame} from '@/lib/growth/db';
import {applyStoreListingDrafts,getCompetitorTracking,setCompetitorCountries,getKeywordTracking,trackStoreKeywords,untrackStoreKeyword,setStoreReviewDone,prepareStoreReviewReply,sendPreparedStoreReviewReply,getStoreListingDrafts,updateStoreListingDrafts} from '@/lib/growth/agentActions';
import {changeReviewReplyTemplate,listReviewReplyTemplates} from '@/lib/growth/agentTemplates';
import {writeTags,writeTemplates} from '@/lib/growth/reviewInbox';
import {changeReviewTag,listReviewTags,setStoreReviewTag} from '@/lib/growth/agentReviewTags';
import {setListingChangesStrict,discardListingDrafts,listingDraftsKey} from '@/lib/growth/listingDrafts';
import {setSession} from '@/lib/account/store';
import {db} from '@/database';
import {pauseProjectAccountSync,previewAccountSync,resumeProjectAccountSync} from '@/lib/account/agentSync';
import {AccountAutoSyncer} from '@/lib/account/autoSync';
import {deleteAccountLinkIfUnchanged,recordAccountSyncResult} from '@/lib/account/links';
import {setDiscoverSession} from '@/lib/discover/session';
import {setAgentCloudSharing} from '@/lib/cloud/agentShare';
import {createAgentCloudCopy} from '@/lib/cloud/agentCreate';
import {putCloudLinkIfAbsent} from '@/lib/cloud/links';
import {collaborationStopPlan,planExistingCollaboration,setFirstCollaborationKey} from '@/lib/collab/agent';
import {newDraft,factsFromProject} from '@/lib/website/content';
import {writeSiteRow,readSiteRow} from '@/lib/website/store';
import {getWebsiteDraft,updateWebsiteDraft} from '@/lib/website/agent';
window.runAgentFixture=async()=>{
 const check=(x,msg)=>{if(!x)throw new Error(msg)};
 const templatePlan=await changeReviewReplyTemplate({action:'create',body:'Thanks, {name}!'});
 check((await listReviewReplyTemplates()).templates.length===0 && !templatePlan.sendsToStore,'template preview is local');
 let badTemplate=false;try{await changeReviewReplyTemplate({action:'create',body:'Different',dryRun:false,confirmed:true,expectedPlan:templatePlan.expectedPlan})}catch{badTemplate=true}
 check(badTemplate,'template plan binds text');
 const createdTemplate=await changeReviewReplyTemplate({action:'create',body:'Thanks, {name}!',dryRun:false,confirmed:true,expectedPlan:templatePlan.expectedPlan});
 const savedTemplate=(await listReviewReplyTemplates()).templates[0];
 check(savedTemplate.id===createdTemplate.id && savedTemplate.body==='Thanks, {name}!','template saved');
 const updateTemplate=await changeReviewReplyTemplate({action:'update',id:createdTemplate.id,name:'Greetings'});
 await writeTemplates([{...savedTemplate,createdAt:Date.parse(savedTemplate.createdAt),body:'Changed elsewhere'}]);
 let staleTemplate=false;try{await changeReviewReplyTemplate({action:'update',id:createdTemplate.id,name:'Greetings',dryRun:false,confirmed:true,expectedPlan:updateTemplate.expectedPlan})}catch{staleTemplate=true}
 check(staleTemplate,'template changed after preview is refused');
 const deleteTemplate=await changeReviewReplyTemplate({action:'delete',id:createdTemplate.id});
 await changeReviewReplyTemplate({action:'delete',id:createdTemplate.id,dryRun:false,confirmed:true,expectedPlan:deleteTemplate.expectedPlan});
 check((await listReviewReplyTemplates()).templates.length===0,'template deleted');
 await writeMeta('reviews:templates',{broken:true});
 let brokenTemplates=false;try{await changeReviewReplyTemplate({action:'create',body:'Do not overwrite'})}catch{brokenTemplates=true}
 check(brokenTemplates && (await readMeta('reviews:templates')).broken===true,'unreadable templates are not replaced');
 await writeTemplates([]);
 setAppStoreCredentials({issuerId:'fixture-issuer',keyId:'fixture-key',privateKey:'fixture-only'});
 await writeMeta('apps:list:fixture-issuer:fixture-key',[{id:'123456',name:'Fixture',bundleId:'test.fixture'}]);
 await writeMeta('rivals:list:123456',{owner:'123456',rivals:[{id:'234',name:'Rival',developer:'Test',iconUrl:null,addedAt:1}],countries:['US']});
 const rivalPlan=await setCompetitorCountries({appId:'123456',countries:['JP','GB']});
 check((await getCompetitorTracking({appId:'123456'})).countries.join(',')==='US' && rivalPlan.laterChecksContactStores,'competitor preview is local');
 let wrongRival=false;try{await setCompetitorCountries({appId:'123456',countries:['FR'],dryRun:false,confirmed:true,expectedPlan:rivalPlan.expectedPlan})}catch{wrongRival=true}
 check(wrongRival,'competitor plan binds countries');
 await writeMeta('rivals:list:123456',{owner:'123456',rivals:[],countries:['US']});
 let staleRival=false;try{await setCompetitorCountries({appId:'123456',countries:['JP','GB'],dryRun:false,confirmed:true,expectedPlan:rivalPlan.expectedPlan})}catch{staleRival=true}
 check(staleRival && (await getCompetitorTracking({appId:'123456'})).countries.join(',')==='US','changed competitor list is refused');
 const rivalAgain=await setCompetitorCountries({appId:'123456',countries:['jp','GB','JP']});
 await setCompetitorCountries({appId:'123456',countries:['jp','GB','JP'],dryRun:false,confirmed:true,expectedPlan:rivalAgain.expectedPlan});
 check((await getCompetitorTracking({appId:'123456'})).countries.join(',')==='JP,GB','competitor countries saved');
 await writeMeta('rivals:list:123456',{broken:true});
 let brokenRival=false;try{await setCompetitorCountries({appId:'123456',countries:['US']})}catch{brokenRival=true}
 check(brokenRival && (await readMeta('rivals:list:123456')).broken===true,'unreadable competitor list is preserved');
 const first=await trackStoreKeywords({appId:'123456',terms:[' Puzzle '],countries:['US']});
 check(first.dryRun===true && first.added[0]==='puzzle','keyword preview');
 check((await getKeywordTracking({appId:'123456'})).keywords.length===0,'preview wrote keywords');
 let wrongKeywords=false; try{await trackStoreKeywords({appId:'123456',terms:['Other'],countries:['US'],...first,dryRun:false,confirmed:true});}catch{wrongKeywords=true}
 check(wrongKeywords,'keyword plan mismatch');
 await trackStoreKeywords({appId:'123456',terms:['Puzzle'],countries:['US'],...first,dryRun:false,confirmed:true});
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
 let wrongReview=false; try{await setStoreReviewDone({appId:'123456',reviewId:'review-fixture',done:false,...review2,dryRun:false,confirmed:true});}catch{wrongReview=true}
 check(wrongReview,'review plan mismatch');
 await setStoreReviewDone({appId:'123456',reviewId:'review-fixture',done:true,...review2,dryRun:false,confirmed:true});
 const marked=(await readReviewMarks(['123456']))[0]; check(!!marked.doneAt && marked.tags[0]==='tag','review mark and tags');
 await writeMeta('reviews:tags',{broken:true});
 let brokenTags=false;try{await listReviewTags()}catch{brokenTags=true}
 check(brokenTags,'unreadable tags are not reported as empty');
 await writeTags([{id:'tag',name:'Bug',color:'1'}]);
 check((await listReviewTags()).tags[0].id==='tag','list review tags');
 const tagPlan=await setStoreReviewTag({appId:'123456',reviewId:'review-fixture',tagId:'tag',enabled:false});
 let badTag=false;try{await setStoreReviewTag({appId:'123456',reviewId:'review-fixture',tagId:'tag',enabled:true,dryRun:false,confirmed:true,expectedPlan:tagPlan.expectedPlan})}catch{badTag=true}
 check(badTag,'tag plan binds target state');
 await writeTags([{id:'tag',name:'Changed elsewhere',color:'1'}]);
 let staleTag=false;try{await setStoreReviewTag({appId:'123456',reviewId:'review-fixture',tagId:'tag',enabled:false,dryRun:false,confirmed:true,expectedPlan:tagPlan.expectedPlan})}catch{staleTag=true}
 check(staleTag,'changed tag is refused');
 const tagAgain=await setStoreReviewTag({appId:'123456',reviewId:'review-fixture',tagId:'tag',enabled:false});
 await setStoreReviewTag({appId:'123456',reviewId:'review-fixture',tagId:'tag',enabled:false,dryRun:false,confirmed:true,expectedPlan:tagAgain.expectedPlan});
 check((await readReviewMarks(['123456']))[0].tags.length===0 && !!(await readReviewMarks(['123456']))[0].doneAt,'tag removed without clearing done mark');
 const newTagPlan=await changeReviewTag({action:'create',name:'Praise'});
 const newTag=await changeReviewTag({action:'create',name:'Praise',dryRun:false,confirmed:true,expectedPlan:newTagPlan.expectedPlan});
 const addTag=await setStoreReviewTag({appId:'123456',reviewId:'review-fixture',tagId:newTag.id,enabled:true});
 await setStoreReviewTag({appId:'123456',reviewId:'review-fixture',tagId:newTag.id,enabled:true,dryRun:false,confirmed:true,expectedPlan:addTag.expectedPlan});
 const deleteTag=await changeReviewTag({action:'delete',id:newTag.id});
 check(deleteTag.affectedReviews===1,'tag delete previews affected reviews');
 await updateReviewMarks([{id:'review-fixture',appId:'123456'}],(mark)=>({...mark,updatedAt:mark.updatedAt+1}));
 let staleDelete=false;try{await changeReviewTag({action:'delete',id:newTag.id,dryRun:false,confirmed:true,expectedPlan:deleteTag.expectedPlan})}catch{staleDelete=true}
 check(staleDelete && (await listReviewTags()).tags.some((tag)=>tag.id===newTag.id),'changed review mark prevents tag deletion');
 const deleteAgain=await changeReviewTag({action:'delete',id:newTag.id});
 await changeReviewTag({action:'delete',id:newTag.id,dryRun:false,confirmed:true,expectedPlan:deleteAgain.expectedPlan});
 check(!(await listReviewTags()).tags.some((tag)=>tag.id===newTag.id) && !!(await readReviewMarks(['123456']))[0].doneAt && !(await readReviewMarks(['123456']))[0].tags.includes(newTag.id),'tag and review marks are updated together');
 const replyPlan=await prepareStoreReviewReply({appId:'123456',reviewId:'review-fixture',text:'Thank you for the feedback.'});
 check(await readReviewReplyDraft('123456','review-fixture')===null,'reply preview wrote data');
 let wrongReply=false; try{await prepareStoreReviewReply({appId:'123456',reviewId:'review-fixture',text:'Different',...replyPlan,dryRun:false,confirmed:true});}catch{wrongReply=true}
 check(wrongReply,'reply plan mismatch');
 await prepareStoreReviewReply({appId:'123456',reviewId:'review-fixture',text:'Thank you for the feedback.',...replyPlan,dryRun:false,confirmed:true});
 check(await readReviewReplyDraft('123456','review-fixture')==='Thank you for the feedback.','prepared reply saved');
 await removeReviewReplyDraftIfSame('123456','review-fixture','different text');
 check(await readReviewReplyDraft('123456','review-fixture')==='Thank you for the feedback.','different reply retained');
 const sendPlan=await sendPreparedStoreReviewReply({appId:'123456',reviewId:'review-fixture'});
 let remoteReview=(await readReviews('123456'))[0], replySends=0, replyFails=false;
 const replyServices={available:()=>true,credentials:getStoreCredentials,fetchAppStore:async()=>[structuredClone(remoteReview)],fetchPlay:async()=>[],send:async(_app,_id,text)=>{replySends++;if(replyFails)throw new Error('network lost');return{id:'response',body:text,lastModified:'2026-11-24T00:00:00Z',state:'PENDING_PUBLISH'}}};
 remoteReview={...remoteReview,body:'Changed elsewhere'};
 let reviewConflict=false; try{await sendPreparedStoreReviewReply({appId:'123456',reviewId:'review-fixture',dryRun:false,confirmed:true,expectedPlan:sendPlan.expectedPlan},replyServices);}catch{reviewConflict=true}
 check(reviewConflict && replySends===0,'changed remote review prevents reply');
 remoteReview=(await readReviews('123456'))[0]; replyFails=true;
 let replyUnknown=false; try{await sendPreparedStoreReviewReply({appId:'123456',reviewId:'review-fixture',dryRun:false,confirmed:true,expectedPlan:sendPlan.expectedPlan},replyServices);}catch(error){replyUnknown=String(error).includes('may have accepted')}
 check(replyUnknown && await readReviewReplyDraft('123456','review-fixture'),'uncertain reply retains draft');
 replyFails=false;
 const sentReply=await sendPreparedStoreReviewReply({appId:'123456',reviewId:'review-fixture',dryRun:false,confirmed:true,expectedPlan:sendPlan.expectedPlan},replyServices);
 check(sentReply.sentToStore && (await readReviews('123456'))[0].response.body==='Thank you for the feedback.' && await readReviewReplyDraft('123456','review-fixture')===null,'sent reply recorded and draft cleared');
 await writeListing({appId:'123456',versionId:'v1',versionString:'1',state:'PREPARE_FOR_SUBMISSION',platform:'IOS',editable:true,appInfoEditable:true,primaryLocale:'en-US',fetchedAt:1000,locales:[{locale:'en-US',name:'Old',subtitle:'Old subtitle',keywords:'',promotionalText:'',description:'',whatsNew:''}]});
 const listingPlan=await updateStoreListingDrafts({appId:'123456',changes:[{locale:'en-US',field:'name',after:'New'}]});
 check((await getStoreListingDrafts({appId:'123456'})).changes.length===0,'listing preview wrote data');
 await setListingChangesStrict('123456',[{locale:'en-US',field:'subtitle',before:'Old subtitle',after:'Edited'}]);
 let listingStale=false; try{await updateStoreListingDrafts({appId:'123456',changes:[{locale:'en-US',field:'name',after:'New'}],...listingPlan,dryRun:false,confirmed:true});}catch{listingStale=true}
 check(listingStale,'stale listing draft');
 const listingPlan2=await updateStoreListingDrafts({appId:'123456',changes:[{locale:'en-US',field:'name',after:'New'}]});
 let wrongListing=false; try{await updateStoreListingDrafts({appId:'123456',changes:[{locale:'en-US',field:'name',after:'Other'}],...listingPlan2,dryRun:false,confirmed:true});}catch{wrongListing=true}
 check(wrongListing,'listing plan mismatch');
 await updateStoreListingDrafts({appId:'123456',changes:[{locale:'en-US',field:'name',after:'New'}],...listingPlan2,dryRun:false,confirmed:true});
 check((await getStoreListingDrafts({appId:'123456'})).changes.length===2,'listing drafts retained');
 const applyPlan=await applyStoreListingDrafts({appId:'123456'});
 check(applyPlan.dryRun && applyPlan.sendsToStore && !applyPlan.remoteChecked,'listing apply preview');
 let wrongApply=false; try{await applyStoreListingDrafts({appId:'123456',dryRun:false,confirmed:true,expectedPlan:'wrong'});}catch{wrongApply=true}
 check(wrongApply,'listing apply preview must match');
 let remote=await readListing('123456'); let sends=0; let failSend=false;
 const services={available:()=>true,credentials:getStoreCredentials,fetchAppStore:async()=>structuredClone(remote),fetchPlay:async()=>null,send:async(_listing,changes)=>{sends++;if(failSend)throw new Error('network lost');const change=changes[0];remote.locales[0][change.field]=change.after;return{applied:[change.locale+':'+change.field],warnings:['Fixture partial result']}}};
 const otherAccount={...services,credentials:()=>({...getStoreCredentials(),appstore:{...getStoreCredentials().appstore,issuerId:'other-issuer'}})};
 let accountConflict=false; try{await applyStoreListingDrafts({appId:'123456',dryRun:false,confirmed:true,expectedPlan:applyPlan.expectedPlan},otherAccount);}catch{accountConflict=true}
 check(accountConflict && sends===0,'changed account prevents listing write');
 remote.locales[0].subtitle='Changed elsewhere';
 let remoteConflict=false; try{await applyStoreListingDrafts({appId:'123456',dryRun:false,confirmed:true,expectedPlan:applyPlan.expectedPlan},services);}catch{remoteConflict=true}
 check(remoteConflict && sends===0,'remote conflict prevents listing write');
 remote=await readListing('123456'); failSend=true;
 let uncertain=false; try{await applyStoreListingDrafts({appId:'123456',dryRun:false,confirmed:true,expectedPlan:applyPlan.expectedPlan},services);}catch(error){uncertain=String(error).includes('may have accepted')}
 check(uncertain && (await getStoreListingDrafts({appId:'123456'})).changes.length===2,'uncertain write keeps drafts');
 failSend=false;
 const sent=await applyStoreListingDrafts({appId:'123456',dryRun:false,confirmed:true,expectedPlan:applyPlan.expectedPlan},services);
 check(sent.applied.length===1 && sent.warnings.length>0 && (await getStoreListingDrafts({appId:'123456'})).changes.length===1,'partial listing write keeps unapplied draft');
 setSession({provider:'github',account:{id:'account-fixture',name:'Fixture'},accessToken:'secret-fixture'});
 await db.accountLinks.put({projectId:'p1',provider:'github',accountId:'account-fixture',remoteId:'secret-remote',stamp:'s',docHash:null,savedAt:new Date(1000),lastPushedName:'Fixture',autoSync:true});
 const syncer=new AccountAutoSyncer({flushLocal:()=>{throw new Error('a stopped sync must not flush')}});
 syncer.configure({projectId:'p1',provider:'github',accountId:'account-fixture',connected:true,enabled:true,collabActive:false,openToken:1});
 syncer.stop({state:'needs-attention',message:'Conflict needs a person',conflict:null});
 syncer.linkChecked=true; syncer.hasLink=true;
 check(syncer.requestSyncNow()===false && syncer.getStatus().state==='needs-attention','agent cannot clear a stopped sync');
 const syncPlan=await previewAccountSync('p1','document-a');
 const changedSyncPlan=await previewAccountSync('p1','document-b');
 check(syncPlan.expectedPlan!==changedSyncPlan.expectedPlan && !JSON.stringify(syncPlan).includes('secret'),'sync preview binds project');
 const pause=await pauseProjectAccountSync({projectId:'p1'});
 await db.accountLinks.update('p1',{remoteId:'replacement-remote'});
 let conflict=false; try{await pauseProjectAccountSync({projectId:'p1',...pause,dryRun:false,confirmed:true});}catch{conflict=true}
 check(conflict && (await db.accountLinks.get('p1')).autoSync===true,'stale sync pause');
 const pause2=await pauseProjectAccountSync({projectId:'p1'});
 const inFlightLink=await db.accountLinks.get('p1');
 const paused=await pauseProjectAccountSync({projectId:'p1',...pause2,dryRun:false,confirmed:true});
 check((await db.accountLinks.get('p1')).autoSync===false && !JSON.stringify(paused).includes('secret'),'sync pause');
 check(await recordAccountSyncResult(inFlightLink,{...inFlightLink,stamp:'after-save'})==='paused','in-flight result recorded');
 check((await db.accountLinks.get('p1')).autoSync===false,'in-flight save preserves paused permission');
 check(!(await deleteAccountLinkIfUnchanged(inFlightLink)) && (await db.accountLinks.get('p1')).stamp==='after-save','stale missing-copy result preserves newer link');
 const wrongResume=await pauseProjectAccountSync({projectId:'p1'});
 let actionConflict=false; try{await resumeProjectAccountSync({projectId:'p1',...wrongResume,dryRun:false,confirmed:true});}catch{actionConflict=true}
 check(actionConflict && !(await db.accountLinks.get('p1')).autoSync,'pause preview cannot authorize resume');
 const resume=await resumeProjectAccountSync({projectId:'p1'});
 await resumeProjectAccountSync({projectId:'p1',...resume,dryRun:false,confirmed:true});
 check((await db.accountLinks.get('p1')).autoSync===true,'sync resumed');
 await db.accountLinks.update('p1',{autoSync:false,stamp:null});
 let missingStamp=false; try{await resumeProjectAccountSync({projectId:'p1'});}catch{missingStamp=true}
 check(missingStamp,'resume requires a known remote stamp');
 setDiscoverSession({token:'secret-cloud-token',viewer:{id:'viewer-fixture',name:'Fixture'},provider:'github',accountId:'account-fixture'});
 let createProject={id:'p-new',name:'New',artboards:[],openToken:1}, cloudSends=0;
 const createPorts={readProject:()=>createProject,flush:async()=>{},available:()=>true,save:async(_id,options)=>{cloudSends++;check(options.createOnly && options.beforeCreate() && options.expectedDocument===JSON.stringify(['New',[]]),'cloud uses create-only');return{project:{},failedAssets:['missing']}}};
 const cloudPlan=await createAgentCloudCopy({projectId:'p-new'},createPorts);
 check(cloudPlan.dryRun && cloudPlan.sendsProject && cloudSends===0 && !JSON.stringify(cloudPlan).includes('secret'),'cloud preview is local');
 await db.cloudLinks.put({projectId:'p-new',recordId:'other-record',accountId:'viewer-fixture',savedAt:new Date(1000),remoteUpdated:'r',visibility:'private',shareSlug:'',pendingAssets:[]});
 let alreadyLinked=false;try{await createAgentCloudCopy({projectId:'p-new',dryRun:false,confirmed:true,expectedPlan:cloudPlan.expectedPlan},createPorts)}catch{alreadyLinked=true}
 check(alreadyLinked && cloudSends===0,'existing cloud link prevents first save');
 await db.cloudLinks.delete('p-new');
 createProject={...createProject,name:'Changed'};
 let staleCloud=false;try{await createAgentCloudCopy({projectId:'p-new',dryRun:false,confirmed:true,expectedPlan:cloudPlan.expectedPlan},createPorts)}catch{staleCloud=true}
 check(staleCloud && cloudSends===0,'changed project prevents first cloud save');
 createProject={...createProject,name:'New'};
 const interruptedPorts={...createPorts,flush:async()=>{createProject={...createProject,openToken:2}}};
 let changedDuringFlush=false;try{await createAgentCloudCopy({projectId:'p-new',dryRun:false,confirmed:true,expectedPlan:cloudPlan.expectedPlan},interruptedPorts)}catch{changedDuringFlush=true}
 check(changedDuringFlush && cloudSends===0,'project change during flush prevents sending');
 createProject={...createProject,openToken:1};
 let uncertainCloud=false;try{await createAgentCloudCopy({projectId:'p-new',dryRun:false,confirmed:true,expectedPlan:cloudPlan.expectedPlan},{...createPorts,save:async()=>{throw new Error('network lost')}})}catch(error){uncertainCloud=String(error).includes('Check the cloud')}
 check(uncertainCloud,'unknown cloud outcome requires inspection');
 const createdCloud=await createAgentCloudCopy({projectId:'p-new',dryRun:false,confirmed:true,expectedPlan:cloudPlan.expectedPlan},createPorts);
 check(createdCloud.saved && !createdCloud.complete && createdCloud.missingAssets===1 && cloudSends===1,'partial cloud copy reported');
 await db.cloudLinks.put({projectId:'p1',recordId:'secret-record',accountId:'viewer-fixture',savedAt:new Date(1000),remoteUpdated:'revision-1',visibility:'private',shareSlug:'',pendingAssets:[],collabKey:'secret-room'});
 let refusedLinkOverwrite=false;try{await putCloudLinkIfAbsent('p1','viewer-fixture',{id:'other-record',updated:'new',visibility:'private'},[])}catch{refusedLinkOverwrite=true}
 check(refusedLinkOverwrite && (await db.cloudLinks.get('p1')).recordId==='secret-record','first save cannot replace a newer local link');
 let sharingWrites=0;
 const sharePort={available:()=>true,setShared:async(_id,_project,revision,on)=>{sharingWrites++;check(revision==='revision-1' && on,'conditional sharing inputs');return{visibility:'link',shareSlug:'secret-link',updated:'revision-2'}}};
 const share=await setAgentCloudSharing({projectId:'p1',enabled:true},()=>false,sharePort);
 check(sharingWrites===0 && !JSON.stringify(share).includes('secret'),'sharing preview is private and local');
 let activeRoom=false;try{await setAgentCloudSharing({projectId:'p1',enabled:true,...share,dryRun:false,confirmed:true},()=>true,sharePort)}catch{activeRoom=true}
 check(activeRoom && sharingWrites===0,'active collaboration blocks sharing change');
 const shared=await setAgentCloudSharing({projectId:'p1',enabled:true,...share,dryRun:false,confirmed:true},()=>false,sharePort);
 check(shared.enabled && sharingWrites===1 && !JSON.stringify(shared).includes('secret'),'sharing outcome is private');
 check((await db.cloudLinks.get('p1')).collabKey==='secret-room','sharing keeps room key');
 const join=await planExistingCollaboration('p1','document-a');
 const joinChanged=await planExistingCollaboration('p1','document-b');
 check(join.expectedPlan!==joinChanged.expectedPlan && !join.expectedPlan.includes('secret'),'collaboration preview binds the document without exposing the key');
 await db.cloudLinks.update('p1',{collabKey:undefined});
 const firstRoom=await planExistingCollaboration('p1','document-a');
 check(firstRoom.createsRoom,'first room preview');
 await setFirstCollaborationKey('p1',JSON.stringify(firstRoom.link),'new-secret-room');
 let duplicateRoom=false; try{await setFirstCollaborationKey('p1',JSON.stringify(firstRoom.link),'replacement');}catch{duplicateRoom=true}
 check(duplicateRoom && (await db.cloudLinks.get('p1')).collabKey==='new-secret-room','first room creation rejects stale link');
 const leave=await collaborationStopPlan('p1',{slug:'secret-link',key:'secret-room'},'live',1);
 const leaveChanged=await collaborationStopPlan('p1',{slug:'secret-link',key:'secret-room'},'live',2);
 check(leave!==leaveChanged && !leave.includes('secret'),'collaboration leave preview binds peers');
 const revoke=await setAgentCloudSharing({projectId:'p1',enabled:false},()=>false,sharePort);
 const racePort={available:()=>true,setShared:async()=>{await db.cloudLinks.update('p1',{remoteUpdated:'newer-local'});return{visibility:'private',shareSlug:'',updated:'revision-3'}}};
 let localRace=false;try{await setAgentCloudSharing({projectId:'p1',enabled:false,...revoke,dryRun:false,confirmed:true},()=>false,racePort)}catch{localRace=true}
 check(localRace && (await db.cloudLinks.get('p1')).remoteUpdated==='newer-local','local sharing race is not overwritten');
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
  page.on('pageerror', (error) => console.error('Fixture page error:', error.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return ['localhost', '127.0.0.1'].includes(url.hostname) ? route.continue() : route.abort();
  });
  const bundled = await build({
    stdin: { contents: fixture, resolveDir: process.cwd(), sourcefile: 'agent-fixture.ts', loader: 'ts' },
    bundle: true, write: false, platform: 'browser', format: 'iife',
    define: { 'process.env': '{}', 'process.env.NEXT_PUBLIC_DISCOVER_URL': '""' },
    alias: { '@': path.join(process.cwd(), 'src') }, logLevel: 'silent',
  });
  await page.goto('/');
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  const result = await page.evaluate(() => (window as unknown as { runAgentFixture: () => Promise<string> }).runAgentFixture());
  expect(result).toBe('ok');
});
