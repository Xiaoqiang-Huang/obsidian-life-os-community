import { Platform, requestUrl } from 'obsidian';
import type { IPlugin } from '../plugin-api';
import { AccountDeviceClient, type AccountTransport } from './account-device-client';
import { AccountRefreshClient } from './account-refresh-client';
import { verifyAccountEntitlement } from './account-entitlement';
import { LIFEOS_LICENSE_PUBLIC_KEYS } from './entitlement-token';
import { publishVerifiedAccountAccess } from './account-access';

type Host = Pick<IPlugin,'app'|'settings'|'saveSettings'>;
const runtimes=new WeakMap<object,ReturnType<typeof createRuntime>>();
export function accountRuntime(host:Host) {
  let instance=runtimes.get(host);
  if(!instance){instance=createRuntime(host);runtimes.set(host,instance);instance.catch(()=>runtimes.delete(host));}
  return instance;
}
async function createRuntime(host:Host) {
  if(!Platform.isDesktopApp)throw new Error('邮箱设备授权暂仅支持桌面端；原授权不受影响');
  // Node/Electron modules are loaded only inside the desktop factory.
  const {join}=require('path') as typeof import('path');
  const {homedir}=require('os') as typeof import('os');
  const {createHash,randomUUID,randomBytes}=require('crypto') as typeof import('crypto');
  let safeStorage;
  try{safeStorage=require('electron').remote?.safeStorage;}catch{}
  if(!safeStorage){try{safeStorage=require('@electron/remote').safeStorage;}catch{}}
  if(!safeStorage)throw new Error('宿主安全存储不可用，未改动原授权');
  const [{createHostDeviceSecretCodec},{SharedDeviceIdentityStore},{EncryptedSessionStorage}]=await Promise.all([
    import('./device-secret-codec'),import('./shared-device-identity'),import('./encrypted-session-storage')]);
  const codec=createHostDeviceSecretCodec(safeStorage,process.platform);
  const directory=join(homedir(),'.lifeos','account-auth-v2');
  const identity=await new SharedDeviceIdentityStore(join(directory,'identity'),codec).loadOrCreate();
  const origin=new URL(host.settings.licenseApiBaseUrl).origin;
  const vaultPath=(host.app.vault.adapter as {getBasePath?:()=>string}).getBasePath?.();
  if(!vaultPath)throw new Error('无法确定当前仓库路径，未启用账号存储');
  const canonicalPath=await (require('fs') as typeof import('fs')).promises.realpath(vaultPath);
  const vaultOwner=createHash('sha256').update(process.platform==='win32'?canonicalPath.toLowerCase():canonicalPath).digest('hex');
  const rawStorage=new EncryptedSessionStorage({directory:join(directory,'sessions',createHash('sha256').update(origin).digest('hex')),
    vaultPaths:[vaultPath],deviceKeyId:identity.deviceKeyId},codec);
  const detached='vault-login-required';
  const assertOwner=(state:import('./account-refresh-client').AccountSessionState)=>{
    if(state.vaultOwner!==vaultOwner)throw new Error('会话不属于当前仓库，请重新登录；原仓库会话未修改');
    return state;
  };
  const storage={
    initialize:(state:import('./account-refresh-client').AccountSessionState)=>rawStorage.initialize({...state,vaultOwner}),
    load:async(id:string)=>assertOwner(await rawStorage.load(id)),
    compareAndSwap:async(id:string,revision:number,next:import('./account-refresh-client').AccountSessionState)=>{
      assertOwner(await rawStorage.load(id));assertOwner(next);return rawStorage.compareAndSwap(id,revision,next);
    }
  };
  const refs=[host.settings.licenseAccountSessionId,host.settings.licenseAccountPendingSessionId,host.settings.licenseAccountRegistrationId].filter(id=>id&&id!==detached);
  for(const id of refs){
    let state:import('./account-refresh-client').AccountSessionState|undefined;
    try{state=await rawStorage.load(id);}
    catch(error){
      // A copied configuration can reference a record absent on this OS user.
      // Detach only an explicitly missing record; corruption/codec errors must
      // remain visible rather than silently discarding recovery evidence.
      if(!error||typeof error!=='object'||!('message' in error)||error.message!=='account_session_storage_not_found')throw error;
    }
    if(!state||state.vaultOwner!==vaultOwner){
      publishVerifiedAccountAccess(host.settings,null);
      const before=[host.settings.licenseAccountSessionId,host.settings.licenseAccountPendingSessionId,host.settings.licenseAccountRegistrationId];
      host.settings.licenseAccountSessionId=detached;host.settings.licenseAccountPendingSessionId='';host.settings.licenseAccountRegistrationId='';
      try{await host.saveSettings();}catch(e){[host.settings.licenseAccountSessionId,host.settings.licenseAccountPendingSessionId,host.settings.licenseAccountRegistrationId]=before;throw e;}
      break;
    }
  }
  const transport:AccountTransport=async req=>{
    // Includes email code/login/list calls exposed through client, not only refresh.
    checkOrigin();
    const response=await requestUrl({url:req.url,method:req.method,headers:req.headers,...(req.method==='POST'?{body:req.body}:{}),throw:false});
    return {status:response.status,json:response.json};
  };
  const client=new AccountDeviceClient(origin,transport);
  const refresh=new AccountRefreshClient(origin,transport,identity,storage,LIFEOS_LICENSE_PUBLIC_KEYS);
  const checkOrigin=()=>{if(new URL(host.settings.licenseApiBaseUrl).origin!==origin)throw new Error('授权服务器已变更，请重新打开插件后登录');};
  async function completePending() {
    checkOrigin();const id=host.settings.licenseAccountPendingSessionId;if(!id)return;
    await refresh.refresh(id);
    const state=await storage.load(id);
    if(state.blocked||!state.entitlementToken)throw new Error('新版授权尚未保存，原授权未切换');
    const payload=await verifyAccountEntitlement(state.entitlementToken,LIFEOS_LICENSE_PUBLIC_KEYS,{deviceKeyId:identity.deviceKeyId,sessionId:id});
    if(payload.deviceId!==state.deviceId||payload.licenseId!==state.licenseId)throw new Error('授权绑定不匹配');
    const previous=host.settings.licenseAccountSessionId;
    host.settings.licenseAccountSessionId=id;host.settings.licenseAccountPendingSessionId='';
    try{await host.saveSettings();}catch(e){host.settings.licenseAccountSessionId=previous;host.settings.licenseAccountPendingSessionId=id;throw e;}
    publishVerifiedAccountAccess(host.settings,payload);
  }
  async function restore(force=false) {
    publishVerifiedAccountAccess(host.settings,null);
    checkOrigin();
    if(host.settings.licenseAccountPendingSessionId)await completePending();
    const id=host.settings.licenseAccountSessionId;
    if(id===detached)throw new Error('当前仓库需要重新登录；不会占用额外设备名额，原仓库不受影响');
    publishVerifiedAccountAccess(host.settings,null);
    if(!id)return;
    let state=await storage.load(id);
    if(state.blocked)throw new Error('会话已退出或失效，请重新登录邮箱');
    let payload;
    if(state.entitlementToken){
      try{payload=await verifyAccountEntitlement(state.entitlementToken,LIFEOS_LICENSE_PUBLIC_KEYS,{deviceKeyId:identity.deviceKeyId,sessionId:id});}
      catch{/* Expired or invalid cache cannot grant access. */}
    }
    if(force||!payload||state.pending||payload.refreshAfter<=Math.floor(Date.now()/1000)){
      await refresh.refresh(id);state=await storage.load(id);
      if(state.blocked||!state.entitlementToken)throw new Error('需要重新登录邮箱');
      payload=await verifyAccountEntitlement(state.entitlementToken,LIFEOS_LICENSE_PUBLIC_KEYS,{deviceKeyId:identity.deviceKeyId,sessionId:id});
    }
    if(!payload||payload.deviceId!==state.deviceId||payload.licenseId!==state.licenseId)throw new Error('授权绑定不匹配');
    publishVerifiedAccountAccess(host.settings,payload);
    return payload;
  }
  let serial:Promise<unknown>=Promise.resolve();
  const enqueue=<T>(action:()=>Promise<T>):Promise<T>=>{const result=serial.then(action,action);serial=result.catch(()=>{});return result;};
  return {client,restore:(force=false)=>enqueue(()=>restore(force)),
    activate:(loginToken:string,licenseId:string,deviceLabel:string,migrate:boolean,reEnroll=false)=>{
      // Startup restore may finish while this explicit retry waits in the queue.
      // Capture its target now so that retry cannot become a second registration.
      const recoveringSession=host.settings.licenseAccountPendingSessionId;
      return enqueue(async()=>{
      checkOrigin();
      const old=host.settings;
      if(recoveringSession&&old.licenseAccountSessionId===recoveringSession&&!old.licenseAccountPendingSessionId){
        const recovered=await storage.load(recoveringSession);
        if(recovered.licenseId!==licenseId)throw new Error('请先恢复或退出当前未完成的授权，再切换许可证');
        await restore();return;
      }
      // Retry the durable pending registration rather than create another session.
      // A different license must not silently replace an unfinished migration.
      if(old.licenseAccountPendingSessionId){
        const pending=await storage.load(old.licenseAccountPendingSessionId);
        if(pending.licenseId!==licenseId)throw new Error('请先恢复或退出当前未完成的授权，再切换许可证');
        await completePending();return;
      }
      const mode=reEnroll?'registration-reenroll':migrate?'registration-migrate':'registration-new';
      if(!old.licenseAccountRegistrationId){
        const id='reg_'+randomUUID().replace(/-/g,'');
        await storage.initialize({revision:0,sessionId:id,deviceId:mode,licenseId,refreshToken:randomBytes(32).toString('base64url')});
        old.licenseAccountRegistrationId=id;
      }
      // Retry this save too: no network mutation until the encrypted intent is discoverable.
      await host.saveSettings();
      const intent=await storage.load(old.licenseAccountRegistrationId);
      if(intent.blocked||intent.licenseId!==licenseId||intent.deviceId!==mode)throw new Error('请先退出未完成的注册，再切换授权方式');
      const registration=await client.register({loginToken,identity,licenseId,deviceLabel,platform:process.platform,vaultLabel:host.app.vault.getName(),reEnroll,
        intent:{operationId:intent.sessionId,refreshToken:intent.refreshToken},
        ...(migrate?{legacy:{token:old.licenseEntitlementToken,installationId:old.licenseInstallationId}}:{})});
      await storage.initialize({revision:0,sessionId:registration.sessionId,deviceId:registration.deviceId,licenseId,refreshToken:registration.refreshToken});
      // Persist only a non-secret recovery reference before obtaining the first lease.
      old.licenseAccountPendingSessionId=registration.sessionId;old.licenseAccountRegistrationId='';await host.saveSettings();
      await completePending();
    });},
    logoutLocal:()=>enqueue(async()=>{
      checkOrigin();
      publishVerifiedAccountAccess(host.settings,null);
      const ids=[...new Set([host.settings.licenseAccountSessionId,host.settings.licenseAccountPendingSessionId,host.settings.licenseAccountRegistrationId].filter(id=>id&&id!==detached))];
      for(const id of ids){
        const state=await storage.load(id);
        if(!await storage.compareAndSwap(id,state.revision,{...state,revision:state.revision+1,blocked:true,entitlementToken:undefined}))
          throw new Error('登录状态正在变化，请重试退出');
      }
      host.settings.licenseAccountPendingSessionId='';host.settings.licenseAccountRegistrationId='';await host.saveSettings();
      // Retain account-mode marker: clearing it would silently reactivate legacy authorization.
    })
  };
}
