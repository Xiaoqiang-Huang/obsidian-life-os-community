import type { SharedDeviceIdentity } from './shared-device-identity';
import type { AccountTransport } from './account-device-client';
import { verifyAccountEntitlement } from './account-entitlement';

export interface AccountSessionState {
  revision: number; sessionId: string; deviceId: string; licenseId: string;
  refreshToken: string; entitlementToken?: string; blocked?: boolean;
  pending?: { operationId: string; nextSecret: string };
  vaultOwner?: string;
}
/** Production adapter MUST encrypt outside Vault and implement atomic cross-process CAS.
 * No default/plaintext adapter is supplied. A persistence failure must stop network mutation.
 */
export interface AccountSessionStorage {
  load(sessionId: string): Promise<AccountSessionState>;
  compareAndSwap(sessionId: string, revision: number, next: AccountSessionState): Promise<boolean>;
}
class RefreshFailure extends Error {
  constructor(readonly code: string, readonly retryable: boolean) { super(code); }
}
async function hash(text: string) {
  const data=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return Array.from(new Uint8Array(data),b=>b.toString(16).padStart(2,'0')).join('');
}
function secret() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
}

export class AccountRefreshClient {
  private readonly base: string;
  private readonly inFlight=new Map<string,Promise<{status:'refreshed'|'offline';expiresAt:number}>>();
  constructor(base:string,private readonly transport:AccountTransport,private readonly identity:SharedDeviceIdentity,
    private readonly storage:AccountSessionStorage,
    private readonly trustedKeys:Parameters<typeof verifyAccountEntitlement>[1]) {
    const url=new URL(base);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('account_server_requires_https');
    this.base=url.origin;
  }
  private async post(path:string,body:unknown):Promise<any> {
    let response;
    try {response=await this.transport({url:this.base+'/api/account/'+path,method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});}
    catch {throw new RefreshFailure('account_network_unavailable',true);}
    const result=response.json as any;
    if(response.status<200||response.status>=300||result?.ok!==true){
      const code=typeof result?.error?.code==='string'&&/^[a-z_]{1,80}$/.test(result.error.code)?result.error.code:'account_request_failed';
      throw new RefreshFailure(code,response.status>=500||response.status===429);
    }
    return result.data;
  }
  refresh(sessionId:string) {
    const existing=this.inFlight.get(sessionId);if(existing)return existing;
    const promise=this.run(sessionId).finally(()=>this.inFlight.delete(sessionId));
    this.inFlight.set(sessionId,promise);return promise;
  }
  private async verify(state:AccountSessionState,token:string) {
    // Real hosts can lag the issuer by a few seconds. Wait locally, without
    // new requests or relaxing notBefore/expiry checks. Never authorize early.
    let payload:Awaited<ReturnType<typeof verifyAccountEntitlement>>|undefined;
    for(let attempt=0;attempt<=5;attempt++){
      try{payload=await verifyAccountEntitlement(token,this.trustedKeys,{deviceKeyId:this.identity.deviceKeyId,sessionId:state.sessionId});break;}
      catch(error){
        if(!(error instanceof Error)||error.message!=='Account entitlement is not active yet'||attempt===5)throw error;
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
    }
    if(!payload)throw new Error('account_clock_out_of_sync');
    if(payload.licenseId!==state.licenseId||payload.deviceId!==state.deviceId)throw new Error('account_entitlement_binding_mismatch');
    return payload;
  }
  private async run(sessionId:string):Promise<{status:'refreshed'|'offline';expiresAt:number}> {
    let state=await this.storage.load(sessionId);
    if(state.sessionId!==sessionId||state.blocked)throw new Error('account_login_required');
    if(!state.pending){
      const next={...state,revision:state.revision+1,pending:{operationId:crypto.randomUUID(),nextSecret:secret()}};
      if(!await this.storage.compareAndSwap(sessionId,state.revision,next))throw new Error('account_session_changed_retry');
      state=next; // Durable intent precedes every network request.
    }
    const pending=state.pending!;
    const body={sessionId,operationId:pending.operationId,refreshToken:state.refreshToken,nextRefreshHash:await hash(pending.nextSecret)};
    try {
      const challenge=await this.post('refresh-challenge',body);
      let parts:any;
      try {parts=JSON.parse(challenge.message);}catch{throw new Error('invalid_device_challenge');}
      const scope=await hash(JSON.stringify(['account-refresh-v2',sessionId,pending.operationId,await hash(state.refreshToken),body.nextRefreshHash]));
      if(!Array.isArray(parts)||parts.length!==9||parts[0]!=='lifeos-device-proof'||parts[1]!==1||parts[2]!==challenge.challengeId||
        parts[4]!==this.identity.deviceKeyId||parts[5]!=='refresh'||parts[6]!==scope||parts[7]!==challenge.expiresAt||
        !Number.isFinite(Date.parse(challenge.expiresAt))||Date.parse(challenge.expiresAt)<=Date.now())throw new Error('invalid_device_challenge');
      const result=await this.post('refresh',{...body,challengeId:challenge.challengeId,signature:await this.identity.signChallenge(challenge.message)});
      if(result?.authorizationMode!=='account-entitlement-v2'||result.operationId!==pending.operationId||typeof result.entitlementToken!=='string')
        throw new Error('invalid_account_refresh_response');
      const payload=await this.verify(state,result.entitlementToken);
      const next={...state,revision:state.revision+1,refreshToken:pending.nextSecret,entitlementToken:result.entitlementToken,pending:undefined};
      if(!await this.storage.compareAndSwap(sessionId,state.revision,next))throw new Error('account_session_changed_retry');
      return {status:'refreshed',expiresAt:payload.expiresAt};
    }catch(error){
      if(error instanceof RefreshFailure&&error.code==='session_unavailable'){
        // Persist explicit denial; never fall back to cached or legacy authorization.
        if(!await this.storage.compareAndSwap(sessionId,state.revision,{...state,revision:state.revision+1,blocked:true,entitlementToken:undefined}))
          throw new Error('account_session_changed_retry');
        throw new Error('account_login_required');
      }
      if(error instanceof RefreshFailure&&error.retryable){
        const current=await this.storage.load(sessionId);
        if(!current.blocked&&current.entitlementToken){
          const payload=await this.verify(current,current.entitlementToken);
          return {status:'offline',expiresAt:payload.expiresAt};
        }
      }
      throw error;
    }
  }
}
