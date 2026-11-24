import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';

test('create-only cloud requests never fall back to the legacy upsert', async ({ page }) => {
  await page.route('**/*', (route) => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  const bundled = await build({
    stdin: { contents: `
      import {cloudApi} from '@/lib/cloud/api';
      import {saveProjectToCloud} from '@/lib/cloud/index';
      import {db} from '@/database';
      import {setDiscoverSession} from '@/lib/discover/session';
      window.checkCloudCreate=async()=>{
        setDiscoverSession({token:'fixture-only',viewer:{id:'fixture',name:'Fixture'},provider:'github',accountId:'fixture'});
        const calls=[];
        const real=window.fetch;
        window.fetch=async(url,init)=>{calls.push({url:String(url),method:init.method});return new Response(JSON.stringify({error:'missing'}),{status:404,headers:{'content-type':'application/json'}})};
        try {
          let rejected=false;
          try { await cloudApi.saveProject({projectId:'p1',name:'Fixture',boards:1,formatVersion:1,doc:new Blob(['fixture']),docEncoding:'none',manifestAssets:[],createOnly:true}); } catch { rejected=true; }
          if(!rejected || calls.length!==1 || !calls[0].url.endsWith('/api/openscreengen/projects/create-only') || calls[0].method!=='POST') throw new Error('create-only fallback or wrong route');
          const boards=[{id:'board',elements:[{id:'image',type:'image',imageSrc:'asset:fixture-missing'}]}];
          await db.projects.put({id:'fixture-project',name:'Fixture',timestamp:new Date(),projectData:boards});
          let missing=false;
          try { await saveProjectToCloud('fixture-project',{origin:'manual',createOnly:true,expectedDocument:JSON.stringify(['Fixture',boards]),beforeCreate:()=>true}); } catch(error) { missing=String(error).includes('missing locally'); }
          if(!missing || calls.length!==1) throw new Error('missing local media was sent');
          return 'ok';
        } finally { window.fetch=real; }
      };
    `, resolveDir: process.cwd(), sourcefile: 'cloud-create-fixture.ts', loader: 'ts' },
    bundle: true, write: false, platform: 'browser', format: 'iife',
    define: { 'process.env': '{}', 'process.env.NEXT_PUBLIC_DISCOVER_URL': '"https://fixture.invalid"' },
    alias: { '@': path.join(process.cwd(), 'src') }, logLevel: 'silent',
  });
  await page.goto('/');
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  expect(await page.evaluate(() => (window as unknown as { checkCloudCreate: () => Promise<string> }).checkCloudCreate())).toBe('ok');
});
