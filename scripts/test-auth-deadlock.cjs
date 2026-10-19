// Run: node scripts/test-auth-deadlock.cjs old|new. Proves an onAuthStateChange
// callback that awaits a Supabase call deadlocks the client (see db/sync.js).
// Repro: supabase-js 2.45.4 (vendored UMD) + our inTabLock; an onAuthStateChange
// callback that awaits a Supabase call, fired from the visibility-change path.
global.self = global; global.window = global;
global.localStorage = { _m:{}, getItem(k){return this._m[k]??null}, setItem(k,v){this._m[k]=String(v)}, removeItem(k){delete this._m[k]} };
global.document={currentScript:{tagName:'SCRIPT',src:'http://x/a.js'},visibilityState:'visible',addEventListener(){},removeEventListener(){}};global.location={href:'http://x/'};global.self.supabase=require('/home/user/StockSaathi/js/vendor/supabase-js-2.45.4.umd.js');
const _locks=new Map(),_depth=new Map();
async function inTabLock(name, acquireTimeout, fn){
  if(acquireTimeout===0&&(_depth.get(name)||0)>0){const e=new Error('busy');e.isAcquireTimeout=true;throw e;}
  _depth.set(name,(_depth.get(name)||0)+1);const prev=_locks.get(name)||Promise.resolve();let release;const mine=new Promise(r=>release=r);_locks.set(name,prev.then(()=>mine));
  try{await prev.catch(()=>{});return await fn();}finally{_depth.set(name,(_depth.get(name)||1)-1);release();}
}
const now=Math.floor(Date.now()/1000);
const user={id:'u1',aud:'authenticated',email:'a@b.c'};
const session={access_token:'x.'+Buffer.from(JSON.stringify({sub:'u1',exp:now+3600})).toString('base64')+'.y',refresh_token:'r',expires_in:3600,expires_at:now+3600,token_type:'bearer',user};
localStorage.setItem('sk',JSON.stringify(session));
const fakeFetch=async(url)=>({ok:true,status:200,headers:new Map([['content-type','application/json']]),json:async()=>url.includes('/user')?user:[] ,text:async()=>JSON.stringify(url.includes('/user')?user:[])});
const mode=process.argv[2];
const c=self.supabase.createClient('https://x.supabase.co','anon',{auth:{storage:localStorage,storageKey:'sk',lock:inTabLock,autoRefreshToken:false,persistSession:true,detectSessionInUrl:false},global:{fetch:fakeFetch}});
(async()=>{
  await c.auth.initializePromise;
  c.auth.onAuthStateChange(mode==='old'
    ? async()=>{ await c.auth.getUser(); }
    : ()=>{ setTimeout(async()=>{ await c.auth.getUser(); },0); });
  // what the tab does when it becomes visible again:
  const vis=c.auth._acquireLock(-1,async()=>{await c.auth._recoverAndRefresh();});
  const t0=Date.now();
  const r=await Promise.race([vis.then(()=>c.auth.getSession()).then(()=>'unblocked'), new Promise(r=>setTimeout(()=>r('DEADLOCK (still stuck after 8s)'),8000))]);
  console.log(mode, '->', r, (Date.now()-t0)+'ms');
  process.exit(0);
})();
